import { Contract, JsonRpcProvider } from "ethers";
import { LIVE_CAPABLE_MODES } from "./custodyControls.js";
import { loadHotWallet, executeBuy, executeSell, DEFAULT_STATE_PATH, DEFAULT_RECEIPT_TIMEOUT_MS } from "./liveExecutor.js";

const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

export function shouldUseLiveExecution(portfolio, env = process.env) {
  const mode = String(portfolio?.mode || "paper");
  return LIVE_CAPABLE_MODES.includes(mode) && String(env.LIVE_EXECUTION_ENABLED || "").trim() === "1";
}

let cachedDepsPromise = null;
export function getLiveDeps(env = process.env) {
  if (!cachedDepsPromise) {
    cachedDepsPromise = (async () => {
      const provider = new JsonRpcProvider(env.ETH_RPC_URL, 1, { staticNetwork: true });
      const submitProvider = new JsonRpcProvider(env.FLASHBOTS_RPC_URL || "https://rpc.flashbots.net", 1, { staticNetwork: true });
      const wallet = await loadHotWallet({ provider });
      return { wallet, submitProvider, env, statePath: DEFAULT_STATE_PATH, receiptTimeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS };
    })();
  }
  return cachedDepsPromise;
}

// Resets the memoized wallet/provider connection; tests build fresh deps per run.
export function resetLiveDepsCache() {
  cachedDepsPromise = null;
}

// Mirrors buildPaperFillExecution's return shape (pipeline.js) so executeSell/openPosition
// need no changes beyond calling this instead when live mode is active. A rejected fill
// returns quantity/filled_notional_usd as 0, never omitted -- executeSell's own fallback
// (`qty * pos.current_price` when filled_notional_usd is missing) would otherwise record
// phantom proceeds for a trade that never happened on-chain.
export async function buildLiveFillExecution({ side, tokenAddress, humanQuantity, notionalUsd }, deps) {
  const raw = side === "buy"
    ? await executeBuy({ buyToken: tokenAddress, notionalUsd }, deps)
    : await sellByHumanQuantity(tokenAddress, humanQuantity, deps);

  if (raw.decision !== "filled") {
    return {
      model_version: raw.model_version || "live-rejected",
      decision: raw.decision,
      rejection_reason: raw.rejection_reason,
      side,
      quantity: 0,
      filled_notional_usd: 0,
      fee_usd: 0,
      execution_source: "live",
    };
  }

  return {
    model_version: raw.model_version,
    decision: raw.decision,
    rejection_reason: null,
    side,
    quote_price: raw.quote_price,
    fill_price: raw.fill_price,
    requested_notional_usd: raw.requested_notional_usd,
    filled_notional_usd: raw.filled_notional_usd,
    quantity: raw.quantity,
    slippage_bps: raw.slippage_bps,
    fee_usd: raw.fee_usd,
    tx_hash: raw.tx_hash,
    approval_tx_hash: raw.approval_tx_hash ?? null,
    gas_used: raw.gas_used ?? null,
    execution_source: "live",
  };
}

async function sellByHumanQuantity(tokenAddress, humanQuantity, deps) {
  const decimals = Number(await new Contract(tokenAddress, ERC20_DECIMALS_ABI, deps.wallet.provider).decimals());
  const sellAmountWei = BigInt(Math.round(humanQuantity * 10 ** decimals));
  return executeSell({ sellToken: tokenAddress, sellAmountWei }, deps);
}
