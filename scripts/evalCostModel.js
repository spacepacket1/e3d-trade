// Cost model and exit-rule defaults for offline evaluation (scripts/baselineCompare.js).
//
// This is a side-effect-free mirror of the paper fill model in pipeline.js
// (buildPaperFillExecution: liquidity-bucketed default slippage + fee_bps_per_side on
// each side) and of the exit-related SETTINGS_DEFAULTS. It exists so evaluation
// scripts do not have to import pipeline.js (which loads .env on import). No new
// constants: scripts/verifyBaselineCompare.js asserts parity with pipeline.js, so a
// change there fails the check until this mirror is updated too.

import { inferLiquidityBucket } from "./liquidityExecutionControls.js";

export const PAPER_FILL_DEFAULT_SLIPPAGE_BPS = {
  sell: { deep: 75, medium: 125, thin: 250, very_thin: 400 },
  buy: { deep: 50, medium: 90, thin: 175, very_thin: 300 }
};

// Mirrors of SETTINGS_DEFAULTS values (pipeline.js) used by the evaluation exit rule.
export const EVAL_SETTINGS_DEFAULTS = {
  fee_bps_per_side: 12.5,
  default_stop_distance_pct: 0.20,
  min_stop_distance_pct: 0.15,
  max_stop_distance_pct: 0.40,
  default_target_multiples: [1.5, 2.0, 3.0],
  target_partial_pct: 0.25
};

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Unknown liquidity buckets as "very_thin" (pipeline behaviour: toNum(..., 0)).
export function liquidityBucket(liquidityUsd) {
  return inferLiquidityBucket(toNum(liquidityUsd, 0));
}

// null/undefined/"" mean "no estimate" and fall back to the bucket default. (Note:
// pipeline.js would read an explicit null estimate as 0 bps via Number(null); snapshot
// records use null for "unknown", so the conservative bucket default is used here.)
export function slippageBpsFor(side, liquidityUsd, estimatedSlippageBps = null) {
  const explicit = estimatedSlippageBps === null || estimatedSlippageBps === undefined || estimatedSlippageBps === ""
    ? NaN
    : toNum(estimatedSlippageBps, NaN);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return PAPER_FILL_DEFAULT_SLIPPAGE_BPS[side === "sell" ? "sell" : "buy"][liquidityBucket(liquidityUsd)];
}

// Resolve the exit rule from a settings object (or the mirrored defaults).
export function resolveExitRules(settings = null) {
  const s = settings && typeof settings === "object" ? settings : {};
  const d = EVAL_SETTINGS_DEFAULTS;
  const minStop = Math.max(0.05, toNum(s.min_stop_distance_pct, d.min_stop_distance_pct));
  const maxStop = Math.max(minStop, toNum(s.max_stop_distance_pct, d.max_stop_distance_pct));
  const stop = Math.min(maxStop, Math.max(minStop, toNum(s.default_stop_distance_pct, d.default_stop_distance_pct)));
  const multiples = Array.isArray(s.default_target_multiples) && s.default_target_multiples.length
    ? s.default_target_multiples
    : d.default_target_multiples;
  return {
    stop_distance_pct: stop,
    target_1_multiple: toNum(multiples[0], d.default_target_multiples[0]),
    target_partial_pct: Math.max(0, Math.min(1, toNum(s.target_partial_pct, d.target_partial_pct))),
    fee_bps_per_side: Math.max(0, toNum(s.fee_bps_per_side, d.fee_bps_per_side)),
    source: settings ? "settings" : "defaults_mirror"
  };
}

// Net return of buying $1 at entryPrice and selling the legs [{fraction, price, liquidityUsd}]
// under the paper fill model. Buy: fill = p*(1+slip), fee on notional, cash debit = 1 + fee.
// Sell: fill = p*(1-slip), proceeds = q*fill - fee(q*fill). Matches buildPaperFillExecution.
export function netRoundTripReturn({ entryPrice, entryLiquidityUsd = null, entrySlippageBps = null, legs = [], feeBps = EVAL_SETTINGS_DEFAULTS.fee_bps_per_side }) {
  const p0 = toNum(entryPrice, 0);
  if (!(p0 > 0)) return null;
  const fee = Math.max(0, toNum(feeBps, EVAL_SETTINGS_DEFAULTS.fee_bps_per_side)) / 10000;
  const buySlip = slippageBpsFor("buy", entryLiquidityUsd, entrySlippageBps) / 10000;
  const quantity = 1 / (p0 * (1 + buySlip));
  const cashDebit = 1 + fee;
  let proceeds = 0;
  for (const leg of legs) {
    const price = toNum(leg.price, 0);
    const fraction = Math.max(0, Math.min(1, toNum(leg.fraction, 0)));
    if (!(price > 0) || !(fraction > 0)) continue;
    // executeSell passes the position's entry execution_data, so an entry slippage
    // estimate (when present) is also used on exit; otherwise the sell bucket default.
    const sellSlip = slippageBpsFor("sell", leg.liquidityUsd ?? entryLiquidityUsd, entrySlippageBps) / 10000;
    const gross = quantity * fraction * price * (1 - sellSlip);
    proceeds += gross - gross * fee;
  }
  return proceeds / cashDebit - 1;
}

// Mirror of the execution assumptions buildTrendSleeveCandidate (pipeline.js) uses for
// the system's own WETH trend-sleeve trades; used for the buy-and-hold ETH baseline.
export const ETH_SLEEVE_EXECUTION = {
  liquidity_usd: 5_000_000_000,
  estimated_slippage_bps: 5
};
