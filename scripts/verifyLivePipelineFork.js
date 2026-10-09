import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { JsonRpcProvider, parseEther } from "ethers";
import { loadHotWallet, WETH, USDC, DEFAULT_STATE_PATH } from "./liveExecutor.js";

for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
}

const FORK_PORT = 8547;
const FORK_URL = `http://127.0.0.1:${FORK_PORT}`;
const upstream = process.env.ETH_RPC_URL;
if (!upstream) throw new Error("ETH_RPC_URL is not set; the fork needs an upstream mainnet RPC");

const anvil = spawn("anvil", ["--fork-url", upstream, "--port", String(FORK_PORT), "--accounts", "1"], { stdio: ["ignore", "pipe", "pipe"] });
let anvilLog = "";
anvil.stdout.on("data", (d) => { anvilLog += d; });
anvil.stderr.on("data", (d) => { anvilLog += d; });
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
  throw new Error("anvil fork did not start: " + anvilLog.slice(-500).replace(/[A-Za-z0-9]{32}/g, "<key>"));
}

const stateBackup = fs.existsSync(DEFAULT_STATE_PATH) ? fs.readFileSync(DEFAULT_STATE_PATH, "utf8") : null;
function restoreState() {
  if (stateBackup === null) fs.rmSync(DEFAULT_STATE_PATH, { force: true });
  else fs.writeFileSync(DEFAULT_STATE_PATH, stateBackup);
}

function buildPortfolio(overrides = {}) {
  return {
    mode: "tiny_live",
    cash_usd: overrides.cash_usd ?? 1000,
    positions: {},
    closed_trades: [],
    action_history: [],
    cooldowns: {},
    stats: {},
    settings: { min_trade_usd: 1, max_open_positions: 5, max_thesis_positions: 5, max_new_positions_per_day: 5, fee_bps_per_side: 0 }
  };
}

function buildUsdcCandidate() {
  return {
    source_agent: "scout",
    token: { symbol: "USDC", name: "USD Coin", chain: "ethereum", contract_address: USDC, category: "stable" },
    market_data: { current_price: 1, change_24h_pct: 0, change_30m_pct: 0, volume_24h_usd: 1e9, market_cap_usd: 1e10, price_source: "e3d", price_timestamp: new Date().toISOString() },
    liquidity_data: { liquidity_usd: 5e7, liquidity_source: "e3d", liquidity_timestamp: new Date().toISOString() },
    targets: { target_1: 1, target_2: 1, target_3: 1 },
    invalidation_price: 0.9,
    _score: 100
  };
}

const results = [];
function report(name) { results.push(name); console.log(`ok  ${name}`); }

try {
  await waitForFork();
  // pipeline.js's own top-level .env loader runs on import and unconditionally
  // overwrites process.env (no "only if unset" guard), so the fork override has
  // to be set AFTER importing it or pipeline.js's loader wins and points
  // getLiveDeps() at real mainnet instead of the fork.
  const { openPosition, executeSell } = await import("../pipeline.js");
  process.env.ETH_RPC_URL = FORK_URL;
  process.env.FLASHBOTS_RPC_URL = FORK_URL;
  process.env.LIVE_EXECUTION_ENABLED = "1";
  delete process.env.LIVE_TRADING_HALT;

  const provider = new JsonRpcProvider(FORK_URL, 1, { staticNetwork: true });
  const wallet = await loadHotWallet({ provider });
  await provider.send("anvil_setBalance", [wallet.address, "0x" + parseEther("0.3").toString(16)]);
  await (await wallet.sendTransaction({ to: WETH, data: "0xd0e30db0", value: parseEther("0.2") })).wait();
  const nonceBefore = await provider.getTransactionCount(wallet.address, "latest");

  const halted = buildPortfolio();
  process.env.LIVE_TRADING_HALT = "1";
  const haltedTrade = await openPosition(halted, buildUsdcCandidate(), 27, "buy");
  assert.equal(haltedTrade, null, "a halted live buy must return null, not open a position");
  assert.equal(Object.keys(halted.positions).length, 0, "no position recorded while halted");
  assert.equal(halted.cash_usd, 1000, "no cash debited while halted");
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), nonceBefore, "halted buy must send no transaction");
  delete process.env.LIVE_TRADING_HALT;
  report("pipeline.openPosition in live mode: halt flag blocks the buy, no position, no cash debited, no transaction");

  const portfolio = buildPortfolio();
  const buyTrade = await openPosition(portfolio, buildUsdcCandidate(), 27, "buy");
  assert(buyTrade, "live buy through pipeline.openPosition should succeed");
  assert(buyTrade.tx_hash, "trade carries the real swap tx hash");
  assert(portfolio.positions.USDC, "position recorded in portfolio state");
  const pos = portfolio.positions.USDC;
  assert(pos.quantity > 0, "position quantity set from the real fill");
  assert(Math.abs(pos.cost_basis_usd - pos.avg_entry_price * pos.quantity) < 1e-6, "avg_entry_price derived from real cost/quantity");
  assert(Math.abs(portfolio.cash_usd - (1000 - buyTrade.cash_debit_usd)) < 1e-6, "paper cash_usd debited by the trade's real cash_debit_usd");
  report(`pipeline.openPosition in live mode: real swap filled (${pos.quantity.toFixed(2)} USDC), position and cash correctly recorded`);

  const sellTrade = await executeSell(portfolio, { symbol: "USDC", fraction: 1, reason: "test_exit" });
  assert(sellTrade, "live sell through pipeline.executeSell should succeed");
  assert(sellTrade.tx_hash, "sell trade carries the real swap tx hash");
  assert(!portfolio.positions.USDC || portfolio.positions.USDC.quantity < 1e-6, "position closed after a full sell");
  assert(portfolio.cash_usd > 1000 - buyTrade.cash_debit_usd, "cash_usd credited back on the real sell");
  report("pipeline.executeSell in live mode: real swap filled, position closed, cash credited");

  console.log(`PASS: live pipeline fork (${results.length} checks)`);
} finally {
  stop();
  restoreState();
}
