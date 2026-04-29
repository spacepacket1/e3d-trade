import crypto from "crypto";
import { buildLiquidityExecutionControls } from "./liquidityExecutionControls.js";
import { buildMarketDataQuality, buildMarketDataQualityRef } from "./marketDataQuality.js";

export const EXECUTION_MODEL_VERSION = "execution-sim-v1";

const DEFAULTS = {
  feeBps: 10,
  slippageBps: 50,
  fallbackLiquidityUsd: 1000000,
  maxFillLiquidityPct: 0.2,
  minPartialFillRatio: 0.1,
  rejectSlippageBps: 500,
  maxMarketImpactBps: 400,
  timeToFillBaseMs: 250,
  timeToFillMaxMs: 300000
};

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashRatio(value) {
  const hex = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  return parseInt(hex, 16) / 0xffffffffffff;
}

function cleanSide(side) {
  return String(side || "").trim().toLowerCase() === "sell" ? "sell" : "buy";
}

function sideSign(side) {
  return cleanSide(side) === "buy" ? 1 : -1;
}

function inferLiquidityBucket(liquidityUsd) {
  if (liquidityUsd >= 1000000) return "deep";
  if (liquidityUsd >= 100000) return "medium";
  if (liquidityUsd >= 20000) return "thin";
  return "very_thin";
}

function inferSpreadBps(liquidityUsd, explicitSpreadBps = null) {
  const explicit = toNum(explicitSpreadBps, NaN);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (liquidityUsd >= 1000000) return 8;
  if (liquidityUsd >= 100000) return 20;
  if (liquidityUsd >= 20000) return 60;
  return 150;
}

function qualitySnapshot(order, options) {
  return buildMarketDataQuality(order, {
    evaluated_at: order?.evaluated_at || order?.ts || options?.evaluated_at || null
  });
}

function extractNotionalUsd(order, decisionPrice) {
  return toNum(
    order?.notional_usd,
    toNum(order?.cost_usd,
      toNum(order?.proceeds_usd,
        toNum(order?.paper_trade_ticket?.allocation_usd,
          toNum(order?.quantity, 0) * decisionPrice)))
  );
}

function postFillAdverseMovementBps(order, side, fillPrice) {
  const finalMark = toNum(
    order?.final_mark_price,
    toNum(order?.mark_price,
      toNum(order?.current_price, NaN))
  );
  if (!(finalMark > 0) || !(fillPrice > 0)) return null;
  const sign = sideSign(side);
  return round(((fillPrice - finalMark) / fillPrice) * sign * 10000, 4);
}

function attachExecutionControls(order, execution, options) {
  const executionControl = buildLiquidityExecutionControls(order, execution, {
    ...options,
    modelVersion: options.executionControlModelVersion
  });
  return {
    ...execution,
    execution_control_id: executionControl.control_id,
    quote_id: executionControl.quote_id,
    liquidity_execution_control: executionControl
  };
}

export function simulateExecution(order = {}, options = {}) {
  const side = cleanSide(order.side);
  const sign = sideSign(side);
  const seed = String(options.seed || "default");
  const modelVersion = options.modelVersion || EXECUTION_MODEL_VERSION;
  const marketDataQuality = qualitySnapshot(order, options);
  const decisionPrice = toNum(order?.decision_price, toNum(order?.price, toNum(order?.arrival_price, toNum(marketDataQuality.normalized?.price_usd, 0))));
  const arrivalPrice = toNum(order?.arrival_price, toNum(order?.paper_trade_ticket?.assumed_entry, toNum(marketDataQuality.normalized?.price_usd, decisionPrice)));
  const requestedNotionalUsd = extractNotionalUsd(order, decisionPrice);
  const requestedQuantity = decisionPrice > 0
    ? toNum(order?.quantity, requestedNotionalUsd / decisionPrice)
    : toNum(order?.quantity, 0);
  const liquidityUsd = Math.max(0, toNum(order?.liquidity_usd, toNum(marketDataQuality.normalized?.liquidity_usd, toNum(options?.fallbackLiquidityUsd, DEFAULTS.fallbackLiquidityUsd))));
  const spreadBps = inferSpreadBps(liquidityUsd, order?.spread_bps ?? marketDataQuality.normalized?.spread_bps ?? order?.execution_data?.spread_bps);
  const feeBps = Math.max(0, toNum(order?.fee_bps, toNum(options.feeBps, DEFAULTS.feeBps)));
  const baseSlippageBps = Math.max(0, toNum(
    order?.slippage_bps,
    toNum(marketDataQuality.normalized?.slippage_bps, toNum(order?.execution_data?.estimated_slippage_bps, toNum(options.slippageBps, DEFAULTS.slippageBps)))
  ));
  const maxFillLiquidityPct = Math.max(0.0001, toNum(options.maxFillLiquidityPct, DEFAULTS.maxFillLiquidityPct));
  const maxFillNotionalUsd = liquidityUsd > 0 ? liquidityUsd * maxFillLiquidityPct : requestedNotionalUsd;
  const fillRatioRaw = requestedNotionalUsd > 0 ? Math.min(1, maxFillNotionalUsd / requestedNotionalUsd) : 0;
  const fillRatio = fillRatioRaw >= 1 ? 1 : Math.max(0, fillRatioRaw);
  const sizeLiquidityRatio = liquidityUsd > 0 ? requestedNotionalUsd / liquidityUsd : 1;
  const impactJitter = 0.85 + hashRatio(`${seed}:${modelVersion}:${order.trade_id || order.source_trade_id || ""}:impact`) * 0.3;
  const marketImpactBps = Math.min(
    toNum(options.maxMarketImpactBps, DEFAULTS.maxMarketImpactBps),
    Math.sqrt(Math.max(0, sizeLiquidityRatio)) * baseSlippageBps * impactJitter
  );
  const halfSpreadBps = spreadBps / 2;
  const executionSlippageBps = baseSlippageBps * (0.9 + hashRatio(`${seed}:${modelVersion}:${order.trade_id || ""}:slip`) * 0.2);
  const totalAdverseBps = halfSpreadBps + executionSlippageBps + marketImpactBps;
  const maxAllowedSlippageBps = toNum(
    order?.paper_trade_ticket?.max_slippage_bps,
    toNum(options.rejectSlippageBps, DEFAULTS.rejectSlippageBps)
  ) || toNum(options.rejectSlippageBps, DEFAULTS.rejectSlippageBps);

  if (!(decisionPrice > 0) || !(requestedNotionalUsd > 0) || !(requestedQuantity > 0)) {
    return attachExecutionControls(order, {
      model_version: modelVersion,
      decision: "rejected",
      rejection_reason: "invalid_price_or_size",
      side,
      arrival_price: round(arrivalPrice),
      decision_price: round(decisionPrice),
      quote_price: 0,
      simulated_fill_price: 0,
      fill_price: 0,
      requested_notional_usd: round(requestedNotionalUsd, 2),
      requested_quantity: round(requestedQuantity),
      filled_notional_usd: 0,
      quantity: 0,
      fill_ratio: 0,
      rejection_ratio: 1,
      fee_bps: round(feeBps, 4),
      slippage_bps: 0,
      price_improvement_bps: 0,
      price_degradation_bps: 0,
      time_to_fill_ms: 0,
      post_fill_adverse_movement_bps: null,
      liquidity_usd: round(liquidityUsd, 2),
      liquidity_bucket: inferLiquidityBucket(liquidityUsd),
      spread_bps: round(spreadBps, 4),
      market_impact_bps: 0,
      fee_usd: 0,
      slippage_usd: 0,
      market_data_quality: marketDataQuality,
      market_data_quality_ref: buildMarketDataQualityRef(marketDataQuality, { context: "execution_simulator" }),
      data_quality_id: marketDataQuality.data_quality_id
    }, options);
  }

  if (totalAdverseBps > maxAllowedSlippageBps) {
    return attachExecutionControls(order, {
      model_version: modelVersion,
      decision: "rejected",
      rejection_reason: "simulated_slippage_above_limit",
      side,
      arrival_price: round(arrivalPrice),
      decision_price: round(decisionPrice),
      quote_price: round(decisionPrice * (1 + sign * halfSpreadBps / 10000)),
      simulated_fill_price: 0,
      fill_price: 0,
      requested_notional_usd: round(requestedNotionalUsd, 2),
      requested_quantity: round(requestedQuantity),
      filled_notional_usd: 0,
      quantity: 0,
      fill_ratio: 0,
      rejection_ratio: 1,
      fee_bps: round(feeBps, 4),
      slippage_bps: round(totalAdverseBps, 4),
      price_improvement_bps: 0,
      price_degradation_bps: round(totalAdverseBps, 4),
      time_to_fill_ms: 0,
      post_fill_adverse_movement_bps: null,
      liquidity_usd: round(liquidityUsd, 2),
      liquidity_bucket: inferLiquidityBucket(liquidityUsd),
      spread_bps: round(spreadBps, 4),
      market_impact_bps: round(marketImpactBps, 4),
      fee_usd: 0,
      slippage_usd: 0,
      market_data_quality: marketDataQuality,
      market_data_quality_ref: buildMarketDataQualityRef(marketDataQuality, { context: "execution_simulator" }),
      data_quality_id: marketDataQuality.data_quality_id
    }, options);
  }

  const status = fillRatio >= 0.999999 ? "filled" : "partially_filled";
  const quotePrice = decisionPrice * (1 + sign * halfSpreadBps / 10000);
  const fillPrice = decisionPrice * (1 + sign * totalAdverseBps / 10000);
  const filledNotionalUsd = requestedNotionalUsd * fillRatio;
  const filledQuantity = filledNotionalUsd / fillPrice;
  const feeUsd = filledNotionalUsd * feeBps / 10000;
  const slippageUsd = Math.abs(filledQuantity * (fillPrice - decisionPrice));
  const priceDeltaBps = ((fillPrice - decisionPrice) / decisionPrice) * sign * 10000;
  const timeToFillMs = Math.min(
    toNum(options.timeToFillMaxMs, DEFAULTS.timeToFillMaxMs),
    Math.round(toNum(options.timeToFillBaseMs, DEFAULTS.timeToFillBaseMs) * (1 + Math.max(0, sizeLiquidityRatio) * 20))
  );

  return attachExecutionControls(order, {
    model_version: modelVersion,
    decision: status,
    rejection_reason: null,
    side,
    arrival_price: round(arrivalPrice),
    decision_price: round(decisionPrice),
    quote_price: round(quotePrice),
    simulated_fill_price: round(fillPrice),
    fill_price: round(fillPrice),
    requested_notional_usd: round(requestedNotionalUsd, 2),
    requested_quantity: round(requestedQuantity),
    filled_notional_usd: round(filledNotionalUsd, 2),
    quantity: round(filledQuantity),
    fill_ratio: round(fillRatio, 6),
    rejection_ratio: round(1 - fillRatio, 6),
    fee_bps: round(feeBps, 4),
    slippage_bps: round(priceDeltaBps, 4),
    price_improvement_bps: priceDeltaBps < 0 ? round(Math.abs(priceDeltaBps), 4) : 0,
    price_degradation_bps: priceDeltaBps > 0 ? round(priceDeltaBps, 4) : 0,
    time_to_fill_ms: timeToFillMs,
    post_fill_adverse_movement_bps: postFillAdverseMovementBps(order, side, fillPrice),
    liquidity_usd: round(liquidityUsd, 2),
    liquidity_bucket: inferLiquidityBucket(liquidityUsd),
    spread_bps: round(spreadBps, 4),
    market_impact_bps: round(marketImpactBps, 4),
    fee_usd: round(feeUsd, 2),
    slippage_usd: round(slippageUsd, 2),
    market_data_quality: marketDataQuality,
    market_data_quality_ref: buildMarketDataQualityRef(marketDataQuality, { context: "execution_simulator" }),
    data_quality_id: marketDataQuality.data_quality_id
  }, options);
}

export function simulateIdealDecisionFill(order = {}, options = {}) {
  const side = cleanSide(order.side);
  const marketDataQuality = qualitySnapshot(order, options);
  const decisionPrice = toNum(order?.decision_price, toNum(order?.price, toNum(marketDataQuality.normalized?.price_usd, 0)));
  const arrivalPrice = toNum(order?.arrival_price, toNum(order?.paper_trade_ticket?.assumed_entry, toNum(marketDataQuality.normalized?.price_usd, decisionPrice)));
  const requestedNotionalUsd = extractNotionalUsd(order, decisionPrice);
  const requestedQuantity = decisionPrice > 0
    ? toNum(order?.quantity, requestedNotionalUsd / decisionPrice)
    : toNum(order?.quantity, 0);
  if (!(decisionPrice > 0) || !(requestedNotionalUsd > 0) || !(requestedQuantity > 0)) {
    return simulateExecution(order, { ...options, feeBps: 0, slippageBps: 0, rejectSlippageBps: 0 });
  }
  return attachExecutionControls(order, {
    model_version: "decision-price-no-cost-v1",
    decision: "filled",
    rejection_reason: null,
    side,
    arrival_price: round(arrivalPrice),
    decision_price: round(decisionPrice),
    quote_price: round(decisionPrice),
    simulated_fill_price: round(decisionPrice),
    fill_price: round(decisionPrice),
    requested_notional_usd: round(requestedNotionalUsd, 2),
    requested_quantity: round(requestedQuantity),
    filled_notional_usd: round(requestedNotionalUsd, 2),
    quantity: round(requestedQuantity),
    fill_ratio: 1,
    rejection_ratio: 0,
    fee_bps: 0,
    slippage_bps: 0,
    price_improvement_bps: 0,
    price_degradation_bps: 0,
    time_to_fill_ms: 0,
    post_fill_adverse_movement_bps: postFillAdverseMovementBps(order, side, decisionPrice),
    liquidity_usd: round(toNum(order?.liquidity_usd, toNum(marketDataQuality.normalized?.liquidity_usd, toNum(options?.fallbackLiquidityUsd, DEFAULTS.fallbackLiquidityUsd))), 2),
    liquidity_bucket: inferLiquidityBucket(toNum(order?.liquidity_usd, toNum(marketDataQuality.normalized?.liquidity_usd, toNum(options?.fallbackLiquidityUsd, DEFAULTS.fallbackLiquidityUsd)))),
    spread_bps: 0,
    market_impact_bps: 0,
    fee_usd: 0,
    slippage_usd: 0,
    market_data_quality: marketDataQuality,
    market_data_quality_ref: buildMarketDataQualityRef(marketDataQuality, { context: "execution_simulator" }),
    data_quality_id: marketDataQuality.data_quality_id
  }, options);
}
