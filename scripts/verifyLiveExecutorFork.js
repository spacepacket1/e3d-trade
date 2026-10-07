import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { JsonRpcProvider, Contract, parseEther } from "ethers";
import { loadHotWallet, executeBuy, executeSell, readState, writeState, WETH, USDC } from "./liveExecutor.js";

for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
}

const FORK_PORT = 8546;
const FORK_URL = `http://127.0.0.1:${FORK_PORT}`;
const upstream = process.env.ETH_RPC_URL;
if (!upstream) throw new Error("ETH_RPC_URL is not set; the fork needs an upstream mainnet RPC");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "live-executor-fork-"));
const statePath = path.join(scratch, "live-state.json");

let anvilLog = "";
const anvil = spawn("anvil", ["--fork-url", upstream, "--port", String(FORK_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
anvil.stdout.on("data", (d) => { anvilLog += d; });
anvil.stderr.on("data", (d) => { anvilLog += d; });
anvil.on("error", (e) => { anvilLog += String(e); });
const stop = () => { try { anvil.kill(); } catch {} };
process.on("exit", stop);

async function waitForFork() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(FORK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("anvil fork did not start: " + anvilLog.split(upstream).join("<upstream>").replace(/[A-Za-z0-9]{32}/g, "<key>").slice(-800));
}

const provider = new JsonRpcProvider(FORK_URL, 1, { staticNetwork: true });
const results = [];
function report(name) { results.push(name); console.log(`ok  ${name}`); }

try {
  await waitForFork();
  const wallet = await loadHotWallet({ provider });
  await provider.send("anvil_setBalance", [wallet.address, "0x" + parseEther("0.3").toString(16)]);
  await (await wallet.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("0.2") })).wait();

  const weth = new Contract(WETH, ["function balanceOf(address) view returns (uint256)"], provider);
  const usdc = new Contract(USDC, ["function balanceOf(address) view returns (uint256)"], provider);
  const deps = { wallet, submitProvider: provider, env: { ...process.env, LIVE_EXECUTION_ENABLED: "1" }, statePath, receiptTimeoutMs: 60000 };
  const nonceBefore = await provider.getTransactionCount(wallet.address, "latest");

  writeState({ day: new Date().toISOString().slice(0, 10), daily_buy_usd: 0, consecutive_failures: 0 }, statePath);

  const disabled = await executeBuy({ buyToken: USDC, sellAmountWei: parseEther("0.01") }, { ...deps, env: { ...process.env, LIVE_EXECUTION_ENABLED: "" } });
  assert.equal(disabled.rejection_reason, "live_execution_not_enabled");
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), nonceBefore, "disabled executor must send nothing");
  report("executor refuses to run without LIVE_EXECUTION_ENABLED=1, with no transaction");

  const halted = await executeBuy({ buyToken: USDC, sellAmountWei: parseEther("0.01") }, { ...deps, env: { ...deps.env, LIVE_TRADING_HALT: "1" } });
  assert.equal(halted.rejection_reason, "halted");
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), nonceBefore, "halt must send nothing");
  report("halt flag blocks a buy with no transaction");

  const tooBig = await executeBuy({ buyToken: USDC, sellAmountWei: parseEther("0.1") }, deps);
  assert.equal(tooBig.rejection_reason, "cap_exceeded_per_trade");
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), nonceBefore, "cap breach must send nothing");
  report("per-trade cap blocks an oversized buy with no transaction");

  const buyWethBefore = await weth.balanceOf(wallet.address);
  const buyUsdcBefore = await usdc.balanceOf(wallet.address);
  const buy = await executeBuy({ buyToken: USDC, sellAmountWei: parseEther("0.01") }, deps);
  assert.equal(buy.decision, "filled", `buy should fill, got ${JSON.stringify(buy)}`);
  assert(buy.approval_tx_hash, "first buy needs an ERC-20 approval to AllowanceHolder");
  assert(buy.tx_hash, "swap tx hash recorded");
  const usdcGained = (await usdc.balanceOf(wallet.address)) - buyUsdcBefore;
  const wethSpent = buyWethBefore - (await weth.balanceOf(wallet.address));
  assert(usdcGained > 0n, "USDC received");
  assert.equal(wethSpent, parseEther("0.01"), "exactly the sell amount spent");
  assert(buy.filled_notional_usd > 0 && buy.quantity > 0, "fill reconciled from balances");
  report(`buy 0.01 WETH -> USDC filled after approval (${buy.quantity.toFixed(2)} USDC, fill $${buy.filled_notional_usd.toFixed(2)})`);

  const sellUsdc = usdcGained / 2n;
  const sellWethBefore = await weth.balanceOf(wallet.address);
  const sell = await executeSell({ sellToken: USDC, sellAmountWei: sellUsdc }, deps);
  assert.equal(sell.decision, "filled", `sell should fill, got ${JSON.stringify(sell)}`);
  assert((await weth.balanceOf(wallet.address)) > sellWethBefore, "WETH received on sell");
  report("sell half the USDC back to WETH filled");

  const st = readState(statePath);
  writeState({ ...st, consecutive_failures: 3 }, statePath);
  const breaker = await executeBuy({ buyToken: USDC, sellAmountWei: parseEther("0.01") }, deps);
  assert.equal(breaker.rejection_reason, "circuit_breaker_open");
  writeState({ ...st, consecutive_failures: 0 }, statePath);
  report("circuit breaker blocks buys after repeated failures");

  writeState({ ...readState(statePath), daily_buy_usd: 290 }, statePath);
  const daily = await executeBuy({ buyToken: USDC, sellAmountWei: parseEther("0.01") }, deps);
  assert.equal(daily.rejection_reason, "cap_exceeded_per_day");
  report("daily cap blocks buys past $300");

  console.log(`PASS: live executor fork (${results.length} checks)`);
} finally {
  stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
