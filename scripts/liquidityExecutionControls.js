import crypto from "crypto";

export const LIQUIDITY_EXECUTION_CONTROLS_SCHEMA_VERSION = "1.0";
export const LIQUIDITY_EXECUTION_CONTROLS_MODEL_VERSION = "liquidity-execution-controls-v1";

const DEFAULTS = {
  fallbackLiquidityUsd: 1000000,
  gasUsdByVenue: {
    cex: 0,
    dex: 18
  },
  gasBpsWarnThreshold: 75,
  mevWarnThresholdBps: 35,
  maxSpreadBps: 200,
  maxSlippageBps: 500,
  maxGasBps: 150
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

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanSide(side) {
  return String(side || "").trim().toLowerCase() === "sell" ? "sell" : "buy";
}

function cleanAddress(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function inferVenueType(order = {}) {
  const raw = String(
    order.venue_type ||
    order.venue ||
    order.route_type ||
    order.paper_trade_ticket?.venue_type ||
    order.execution_data?.venue_type ||
    ""
  ).trim().toLowerCase();
  if (raw.includes("cex") || raw.includes("central")) return "cex";
  if (raw.includes("dex") || raw.includes("pool") || raw.includes("swap")) return "dex";
  return cleanAddress(order.contract_address || order.token?.contract_address) ? "dex" : "cex";
}

function inferLiquidityBucket(liquidityUsd) {
  if (liquidityUsd >= 1000000) return "deep";
  if (liquidityUsd >= 100000) return "medium";
  if (liquidityUsd >= 20000) return "thin";
  return "very_thin";
}

function inferQuoteQuality({ spreadBps, slippageBps, marketImpactBps, gasBps, liquidityBucket, fillRatio }) {
  if (fillRatio <= 0) return "rejected";
  if (liquidityBucket === "very_thin" || spreadBps >= 150 || slippageBps >= 250 || marketImpactBps >= 150 || gasBps >= 100) return "poor";
  if (liquidityBucket === "thin" || spreadBps >= 60 || slippageBps >= 100 || marketImpactBps >= 60 || gasBps >= 50) return "fair";
  if (liquidityBucket === "medium" || spreadBps >= 20 || slippageBps >= 40 || marketImpactBps >= 20 || gasBps >= 15) return "good";
  return "excellent";
}

function inferRouteFeasibility({ execution, spreadBps, slippageBps, gasBps, warnings, maxSpreadBps, maxSlippageBps, maxGasBps }) {
  if (execution?.decision === "rejected") return "blocked";
  if (spreadBps > maxSpreadBps || slippageBps > maxSlippageBps || gasBps > maxGasBps) return "limited";
  if (execution?.decision === "partially_filled" || warnings.length) return "limited";
  return "feasible";
}

function extractLiquidityUsd(order, execution, options) {
  return Math.max(0, toNum(
    execution?.liquidity_usd,
    toNum(order?.liquidity_usd,
      toNum(order?.liquidity_data?.liquidity_usd,
        toNum(order?.paper_trade_ticket?.liquidity_usd,
          toNum(order?.last_market_snapshot?.liquidity_data?.liquidity_usd,
            toNum(options?.fallbackLiquidityUsd, DEFAULTS.fallbackLiquidityUsd)))))
  ));
}

function extractRequestedNotional(order, execution) {
  return Math.max(0, toNum(
    execution?.requested_notional_usd,
    toNum(order?.notional_usd,
      toNum(order?.cost_usd,
        toNum(order?.proceeds_usd,
          toNum(order?.paper_trade_ticket?.allocation_usd, 0))))
  ));
}

function inferGasUsd(order, venueType, options) {
  const explicit = toNum(
    order?.gas_usd,
    toNum(order?.execution_data?.gas_usd,
      toNum(order?.paper_trade_ticket?.gas_usd, NaN))
  );
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (venueType === "cex") return toNum(options.gasUsdByVenue?.cex, DEFAULTS.gasUsdByVenue.cex);
  const liquidityUsd = toNum(order?.liquidity_usd, toNum(order?.liquidity_data?.liquidity_usd, DEFAULTS.fallbackLiquidityUsd));
  const thinMultiplier = liquidityUsd > 0 && liquidityUsd < 100000 ? 1.25 : 1;
  return toNum(options.gasUsdByVenue?.dex, DEFAULTS.gasUsdByVenue.dex) * thinMultiplier;
}

function buildWarnings({ venueType, liquidityBucket, spreadBps, slippageBps, marketImpactBps, gasBps, mevRiskBps, fillRatio, execution, thresholds }) {
  const warnings = [];
  if (liquidityBucket === "very_thin") warnings.push("very_thin_liquidity");
  if (liquidityBucket === "thin") warnings.push("thin_liquidity");
  if (spreadBps > thresholds.maxSpreadBps) warnings.push("spread_above_control_limit");
  if (slippageBps > thresholds.maxSlippageBps) warnings.push("slippage_above_control_limit");
  if (marketImpactBps > thresholds.maxSlippageBps / 2) warnings.push("market_impact_elevated");
  if (gasBps > thresholds.gasBpsWarnThreshold) warnings.push("gas_cost_elevated");
  if (gasBps > thresholds.maxGasBps) warnings.push("gas_above_control_limit");
  if (venueType === "dex" && mevRiskBps > thresholds.mevWarnThresholdBps) warnings.push("mev_sandwich_risk_elevated");
  if (fillRatio > 0 && fillRatio < 1) warnings.push("partial_fill_expected");
  if (execution?.decision === "rejected") warnings.push(execution.rejection_reason || "execution_rejected");
  return [...new Set(warnings)].sort();
}

export function buildLiquidityExecutionControls(order = {}, execution = {}, options = {}) {
  const modelVersion = options.modelVersion || LIQUIDITY_EXECUTION_CONTROLS_MODEL_VERSION;
  const side = cleanSide(order.side || execution.side);
  const venueType = inferVenueType(order);
  const symbol = String(order.symbol || order.token?.symbol || "").trim() || null;
  const contractAddress = cleanAddress(order.contract_address || order.token?.contract_address);
  const sourceTradeId = order.trade_id || order.source_trade_id || execution.trade_id || null;
  const requestedNotionalUsd = extractRequestedNotional(order, execution);
  const liquidityUsd = extractLiquidityUsd(order, execution, options);
  const liquidityBucket = execution.liquidity_bucket || inferLiquidityBucket(liquidityUsd);
  const spreadBps = Math.max(0, toNum(execution.spread_bps, toNum(order.spread_bps, toNum(order.execution_data?.spread_bps, 0))));
  const slippageBps = Math.max(0, toNum(execution.price_degradation_bps, toNum(execution.slippage_bps, toNum(order.slippage_bps, 0))));
  const marketImpactBps = Math.max(0, toNum(execution.market_impact_bps, 0));
  const gasUsd = inferGasUsd(order, venueType, options);
  const gasBps = requestedNotionalUsd > 0 ? gasUsd / requestedNotionalUsd * 10000 : 0;
  const fillRatio = Math.max(0, Math.min(1, toNum(execution.fill_ratio, 0)));
  const maxSpreadBps = toNum(options.maxSpreadBps, DEFAULTS.maxSpreadBps);
  const maxSlippageBps = toNum(options.maxSlippageBps, toNum(order.paper_trade_ticket?.max_slippage_bps, DEFAULTS.maxSlippageBps)) || DEFAULTS.maxSlippageBps;
  const maxGasBps = toNum(options.maxGasBps, DEFAULTS.maxGasBps);
  const mevRiskBps = venueType === "dex"
    ? round((spreadBps * 0.2) + (marketImpactBps * 0.35) + (liquidityBucket === "very_thin" ? 30 : liquidityBucket === "thin" ? 12 : 0), 4)
    : 0;
  const thresholds = {
    gasBpsWarnThreshold: toNum(options.gasBpsWarnThreshold, DEFAULTS.gasBpsWarnThreshold),
    mevWarnThresholdBps: toNum(options.mevWarnThresholdBps, DEFAULTS.mevWarnThresholdBps),
    maxSpreadBps,
    maxSlippageBps,
    maxGasBps
  };
  const warnings = buildWarnings({
    venueType,
    liquidityBucket,
    spreadBps,
    slippageBps,
    marketImpactBps,
    gasBps,
    mevRiskBps,
    fillRatio,
    execution,
    thresholds
  });
  const routeFeasibility = inferRouteFeasibility({ execution, spreadBps, slippageBps, gasBps, warnings, maxSpreadBps, maxSlippageBps, maxGasBps });
  const quoteQuality = inferQuoteQuality({ spreadBps, slippageBps, marketImpactBps, gasBps, liquidityBucket, fillRatio });
  const quoteBasis = {
    model_version: modelVersion,
    side,
    symbol,
    contract_address: contractAddress,
    source_trade_id: sourceTradeId,
    requested_notional_usd: round(requestedNotionalUsd, 2),
    decision_price: round(execution.decision_price || order.decision_price || order.price || 0),
    quote_price: round(execution.quote_price || 0),
    liquidity_usd: round(liquidityUsd, 2),
    venue_type: venueType
  };
  const quoteId = `quote_${sha256(stableStringify(quoteBasis)).slice(0, 32)}`;
  const controlId = `execctl_${sha256(stableStringify({
    ...quoteBasis,
    execution_decision: execution.decision || null,
    route_feasibility: routeFeasibility,
    warnings
  })).slice(0, 32)}`;

  return {
    schema_version: LIQUIDITY_EXECUTION_CONTROLS_SCHEMA_VERSION,
    model_version: modelVersion,
    control_id: controlId,
    quote_id: quoteId,
    id_basis: "sha256(stable quote/control basis)",
    live_submission_enabled: false,
    live_submission_attempted: false,
    source_trade_id: sourceTradeId,
    order_id: execution.order_id || order.order_id || null,
    side,
    symbol,
    contract_address: contractAddress,
    venue_type: venueType,
    route_type: venueType === "dex" ? "simulated_dex_pool_quote" : "simulated_cex_order_book_quote",
    quote_quality: quoteQuality,
    liquidity_depth_bucket: liquidityBucket,
    route_feasibility: routeFeasibility,
    quote: {
      quote_id: quoteId,
      decision_price: round(execution.decision_price || order.decision_price || order.price || 0),
      quote_price: round(execution.quote_price || 0),
      requested_notional_usd: round(requestedNotionalUsd, 2),
      requested_quantity: round(execution.requested_quantity || order.quantity || 0),
      spread_bps: round(spreadBps, 4),
      expected_slippage_bps: round(slippageBps, 4),
      market_impact_bps: round(marketImpactBps, 4),
      fill_ratio: round(fillRatio, 6)
    },
    liquidity: {
      liquidity_usd: round(liquidityUsd, 2),
      depth_bucket: liquidityBucket,
      requested_liquidity_pct: liquidityUsd > 0 ? round(requestedNotionalUsd / liquidityUsd * 100, 6) : null
    },
    gas: {
      estimated_gas_usd: round(gasUsd, 2),
      estimated_gas_bps: round(gasBps, 4),
      gas_model: venueType === "dex" ? "deterministic_dex_gas_estimate" : "not_applicable_for_cex_simulation"
    },
    mev: {
      mev_risk_bps: round(mevRiskBps, 4),
      warning: venueType === "dex" && mevRiskBps > thresholds.mevWarnThresholdBps,
      model: venueType === "dex" ? "deterministic_mev_warning_heuristic" : "not_applicable_for_cex_simulation"
    },
    warnings,
    thresholds,
    route_plan: {
      routing_mode: "simulation_only",
      candidate_routes: [venueType === "dex" ? "simulated_dex_pool" : "simulated_cex_book"],
      selected_route: venueType === "dex" ? "simulated_dex_pool" : "simulated_cex_book",
      no_live_venue_adapter: true,
      no_wallet_required: true
    }
  };
}

export function buildLiquidityExecutionControlRef(control = null, context = {}) {
  if (!control?.control_id) return null;
  return {
    execution_control_id: control.control_id,
    quote_id: control.quote_id || null,
    model_version: control.model_version || null,
    route_feasibility: control.route_feasibility || null,
    quote_quality: control.quote_quality || null,
    report_id: context.report_id || null,
    order_id: control.order_id || context.order_id || null
  };
}
