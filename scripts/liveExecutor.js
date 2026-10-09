import fs from "fs";
import os from "os";
import path from "path";
import { Contract, Wallet } from "ethers";
import { LIVE_CAPS, checkBuy, checkSell, isLiveHalted, shouldTripBreaker } from "./liveCaps.js";
import { fetchZeroxQuote } from "./liveQuote.js";

export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];
const APPROVAL_GAS_ESTIMATE = 60000n;
const MODEL_VERSION = "live-0x-allowance-holder-v1";
const CONFIG_DIR = path.join(os.homedir(), ".config", "e3d-trade");
export const DEFAULT_KEYSTORE_PATH = path.join(CONFIG_DIR, "keystore", "hot-wallet");
export const DEFAULT_PASSWORD_PATH = path.join(CONFIG_DIR, "hot-wallet.pass");
export const DEFAULT_STATE_PATH = path.join(CONFIG_DIR, "live-state.json");
export const DEFAULT_RECEIPT_TIMEOUT_MS = 300000;

export async function loadHotWallet({ provider, keystorePath = DEFAULT_KEYSTORE_PATH, passwordPath = DEFAULT_PASSWORD_PATH }) {
  const json = fs.readFileSync(keystorePath, "utf8");
  const password = fs.readFileSync(passwordPath, "utf8").trim();
  const wallet = await Wallet.fromEncryptedJson(json, password);
  return wallet.connect(provider);
}

export function readState(statePath = DEFAULT_STATE_PATH, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    stored = {};
  }
  const consecutive_failures = Number(stored.consecutive_failures || 0);
  if (stored.day !== today) return { day: today, daily_buy_usd: 0, consecutive_failures };
  return { day: today, daily_buy_usd: Number(stored.daily_buy_usd || 0), consecutive_failures };
}

export function writeState(state, statePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function rejected(reason, extra = {}) {
  return { decision: "rejected", rejection_reason: reason, ...extra };
}

async function ethUsdPrice(quoteFn, taker) {
  const q = await quoteFn({ sellToken: WETH, buyToken: USDC, sellAmountWei: 10n ** 18n, taker });
  return Number(q.buy_amount_wei) / 1e6;
}

function makeQuoteFn(env, override) {
  return override || ((params) => fetchZeroxQuote({ ...params, apiKey: env.ZEROX_API_KEY }));
}

async function sendAndWait(wallet, populated, submitProvider, timeoutMs, { useSubmitProvider }) {
  const signed = await wallet.signTransaction(populated);
  const sender = useSubmitProvider ? submitProvider : wallet.provider;
  let sent;
  try {
    sent = await sender.broadcastTransaction(signed);
  } catch (err) {
    return { error: "tx_submit_failed", message: err.message };
  }
  const receipt = await wallet.provider.waitForTransaction(sent.hash, 1, timeoutMs);
  if (!receipt) return { error: "tx_timeout", hash: sent.hash };
  if (receipt.status !== 1) return { error: "tx_reverted", hash: sent.hash, receipt };
  return { hash: sent.hash, receipt };
}

async function runSwap({ side, sellToken, buyToken, sellAmountWei, quote, ethUsd, wallet, submitProvider, env, state, statePath, receiptTimeoutMs, notionalUsd }) {
  const provider = wallet.provider;
  const toUsd = (wei) => (Number(wei) / 1e18) * ethUsd;
  const sellContract = new Contract(sellToken, ERC20, provider);
  const buyContract = new Contract(buyToken, ERC20, provider);
  const buyDecimals = Number(await buyContract.decimals());

  let approvalHash = null;
  const allowance = await sellContract.allowance(wallet.address, quote.approval_target);
  if (allowance < sellAmountWei) {
    const approveTx = await sellContract.approve.populateTransaction(quote.approval_target, sellAmountWei);
    const populatedApproval = await wallet.populateTransaction(approveTx);
    const approval = await sendAndWait(wallet, populatedApproval, submitProvider, receiptTimeoutMs, { useSubmitProvider: false });
    if (approval.error) return rejected(approval.error, { tx_hash: approval.hash ?? null, stage: "approval" });
    approvalHash = approval.hash;
  }

  const sellBefore = await sellContract.balanceOf(wallet.address);
  const buyBefore = await buyContract.balanceOf(wallet.address);

  const populated = await wallet.populateTransaction({
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: BigInt(quote.transaction.value),
    gasLimit: BigInt(quote.transaction.gas),
  });
  const worstCaseGasUsd = toUsd(BigInt(populated.gasLimit) * BigInt(populated.maxFeePerGas ?? populated.gasPrice));
  if (side === "buy" && worstCaseGasUsd > LIVE_CAPS.max_gas_cost_per_buy_usd) {
    return rejected("gas_cap_exceeded", { stage: "pre_submit", approval_tx_hash: approvalHash });
  }

  if (side === "buy") {
    state.daily_buy_usd += notionalUsd;
    writeState(state, statePath);
  }

  const swap = await sendAndWait(wallet, populated, submitProvider, receiptTimeoutMs, { useSubmitProvider: true });
  if (swap.error) {
    state.consecutive_failures += 1;
    writeState(state, statePath);
    return rejected(swap.error, { tx_hash: swap.hash ?? null, approval_tx_hash: approvalHash });
  }
  state.consecutive_failures = 0;
  writeState(state, statePath);

  const sellAfter = await sellContract.balanceOf(wallet.address);
  const buyAfter = await buyContract.balanceOf(wallet.address);
  const spentWei = sellBefore - sellAfter;
  const receivedWei = buyAfter - buyBefore;
  const wethSideUsd = side === "buy" ? toUsd(spentWei) : toUsd(receivedWei);
  const receivedUnits = Number(receivedWei) / 10 ** buyDecimals;
  const expectedRaw = Number(quote.buy_amount_wei);
  const gasFeeUsd = toUsd(swap.receipt.gasUsed * swap.receipt.gasPrice);
  const fillPrice = receivedUnits > 0 ? wethSideUsd / receivedUnits : 0;

  return {
    model_version: MODEL_VERSION,
    decision: "filled",
    rejection_reason: null,
    side,
    requested_notional_usd: notionalUsd,
    filled_notional_usd: wethSideUsd,
    quantity: receivedUnits,
    quote_price: expectedRaw > 0 ? notionalUsd / (expectedRaw / 10 ** buyDecimals) : 0,
    fill_price: fillPrice,
    slippage_bps: expectedRaw > 0 ? ((expectedRaw - Number(receivedWei)) / expectedRaw) * 10000 : 0,
    fee_usd: gasFeeUsd,
    zerox_fee: quote.zerox_fee,
    tx_hash: swap.hash,
    approval_tx_hash: approvalHash,
    gas_used: swap.receipt.gasUsed.toString(),
  };
}

function liveExecutionEnabled(env) {
  return String(env.LIVE_EXECUTION_ENABLED || "").trim() === "1";
}

export async function executeBuy({ buyToken, notionalUsd }, deps) {
  const { wallet, submitProvider, env = process.env, statePath = DEFAULT_STATE_PATH, receiptTimeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS } = deps;
  if (!liveExecutionEnabled(env)) return rejected("live_execution_not_enabled");
  const state = readState(statePath);
  if (isLiveHalted(env)) return rejected("halted");
  if (shouldTripBreaker(state.consecutive_failures)) return rejected("circuit_breaker_open");
  if (!(notionalUsd > 0)) return rejected("invalid_notional");

  const quoteFn = makeQuoteFn(env, deps.quote);
  const ethUsd = await ethUsdPrice(quoteFn, wallet.address);
  const sellAmountWei = BigInt(Math.round((notionalUsd / ethUsd) * 1e18));
  if (!(sellAmountWei > 0n)) return rejected("invalid_notional");
  const quote = await quoteFn({ sellToken: WETH, buyToken, sellAmountWei, taker: wallet.address });
  if (!quote.liquidity_available) return rejected("insufficient_liquidity");

  const toUsd = (wei) => (Number(wei) / 1e18) * ethUsd;
  const weth = new Contract(WETH, ERC20, wallet.provider);
  const wethBalance = await weth.balanceOf(wallet.address);
  if (wethBalance < sellAmountWei) return rejected("insufficient_balance");
  const ethBalance = await wallet.provider.getBalance(wallet.address);
  const feeData = await wallet.provider.getFeeData();
  const feeWei = BigInt(feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n);
  const allowance = await weth.allowance(wallet.address, quote.approval_target);
  const gasUnits = BigInt(quote.transaction.gas) + (allowance < sellAmountWei ? APPROVAL_GAS_ESTIMATE : 0n);

  const check = checkBuy({
    halted: false,
    notionalUsd,
    dailyBuyUsd: state.daily_buy_usd,
    walletValueUsd: toUsd(wethBalance + ethBalance),
    estimatedGasUsd: toUsd(gasUnits * feeWei),
    ethBalanceUsd: toUsd(ethBalance),
  });
  if (!check.allowed) return rejected(check.reasons[0], { reasons: check.reasons });

  return runSwap({ side: "buy", sellToken: WETH, buyToken, sellAmountWei, quote, ethUsd, wallet, submitProvider, env, state, statePath, receiptTimeoutMs, notionalUsd });
}

export async function executeSell({ sellToken, sellAmountWei }, deps) {
  const { wallet, submitProvider, env = process.env, statePath = DEFAULT_STATE_PATH, receiptTimeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS } = deps;
  if (!liveExecutionEnabled(env)) return rejected("live_execution_not_enabled");
  const state = readState(statePath);
  const gate = checkSell({ halted: isLiveHalted(env) });
  if (!gate.allowed) return rejected(gate.reasons[0]);
  if (shouldTripBreaker(state.consecutive_failures)) return rejected("circuit_breaker_open");
  if (!(sellAmountWei > 0n)) return rejected("invalid_notional");

  const quoteFn = makeQuoteFn(env, deps.quote);
  const ethUsd = await ethUsdPrice(quoteFn, wallet.address);
  const quote = await quoteFn({ sellToken, buyToken: WETH, sellAmountWei, taker: wallet.address });
  if (!quote.liquidity_available) return rejected("insufficient_liquidity");
  const sellBalance = await new Contract(sellToken, ERC20, wallet.provider).balanceOf(wallet.address);
  if (sellBalance < sellAmountWei) return rejected("insufficient_balance");

  const notionalUsd = (Number(quote.buy_amount_wei) / 1e18) * ethUsd;
  return runSwap({ side: "sell", sellToken, buyToken: WETH, sellAmountWei, quote, ethUsd, wallet, submitProvider, env, state, statePath, receiptTimeoutMs, notionalUsd });
}
