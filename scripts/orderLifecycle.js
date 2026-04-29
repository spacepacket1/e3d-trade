import crypto from "crypto";
import { buildLiquidityExecutionControlRef } from "./liquidityExecutionControls.js";

export const ORDER_LIFECYCLE_SCHEMA_VERSION = "1.0";
export const ORDER_STATES = Object.freeze([
  "planned",
  "risk_rejected",
  "approved",
  "submitted",
  "acknowledged",
  "partially_filled",
  "filled",
  "cancel_requested",
  "canceled",
  "expired",
  "rejected",
  "failed"
]);
export const ORDER_MODES = Object.freeze(["research", "paper", "shadow"]);

const STATE_SET = new Set(ORDER_STATES);
const MODE_SET = new Set(ORDER_MODES);

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

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

function cleanAddress(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function cleanSide(value) {
  const side = String(value || "").trim().toLowerCase();
  return side === "sell" ? "sell" : "buy";
}

function cleanText(value) {
  return String(value || "").trim() || null;
}

function cleanList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value))
    .filter(Boolean))];
}

function extractRiskDecisionId(ref = null) {
  if (!ref || typeof ref !== "object") return null;
  return ref.risk_decision_id || null;
}

function extractExecutionControlId(execution = null, ref = null) {
  return ref?.execution_control_id || execution?.execution_control_id || execution?.liquidity_execution_control?.control_id || null;
}

function inferRequestedNotional(trade = {}, execution = null) {
  return round(
    toNum(execution?.requested_notional_usd,
      toNum(trade?.notional_usd,
        toNum(trade?.cost_usd,
          toNum(trade?.proceeds_usd,
            toNum(trade?.gross_proceeds_usd,
              toNum(trade?.paper_trade_ticket?.allocation_usd, 0)))))),
    2
  );
}

function inferRequestedQuantity(trade = {}, execution = null, requestedNotionalUsd = 0) {
  const price = toNum(trade?.price, toNum(execution?.decision_price, toNum(execution?.fill_price, 0)));
  return round(
    toNum(execution?.requested_quantity,
      toNum(trade?.quantity, price > 0 && requestedNotionalUsd > 0 ? requestedNotionalUsd / price : 0))
  );
}

function extractEvidencePacketId(input = {}) {
  return cleanText(
    input.evidence_packet_id
    || input.trade?.evidence_packet_id
    || input.trade?.paper_trade_ticket?.evidence_packet_id
    || input.trade?.evidence_summary?.evidence_packet_id
    || input.trade?.paper_trade_ticket?.evidence_summary?.evidence_packet_id
  );
}

function extractEvidenceRefs(input = {}) {
  return cleanList(
    input.evidence_refs
    || input.trade?.evidence_refs
    || input.trade?.paper_trade_ticket?.evidence_refs
    || input.trade?.evidence_summary?.refs_used
    || input.trade?.paper_trade_ticket?.evidence_summary?.refs_used
  );
}

function extractEvidenceSummary(input = {}) {
  const summary = input.evidence_summary
    || input.trade?.evidence_summary
    || input.trade?.paper_trade_ticket?.evidence_summary
    || null;
  if (!summary || typeof summary !== "object") return null;
  return {
    evidence_packet_id: cleanText(summary.evidence_packet_id || extractEvidencePacketId(input)),
    quality_score: summary.quality_score == null ? null : round(toNum(summary.quality_score, 0), 4),
    evidence_count: Math.max(0, Math.round(toNum(summary.evidence_count, 0))),
    refs_used: cleanList(summary.refs_used),
    blockers: cleanList(summary.blockers),
    warnings: cleanList(summary.warnings),
    highlights: (Array.isArray(summary.highlights) ? summary.highlights : [])
      .slice(0, 3)
      .map((item) => ({
        evidence_id: cleanText(item?.evidence_id),
        source_type: cleanText(item?.source_type),
        label: cleanText(item?.label),
        direction: cleanText(item?.direction),
        strength: item?.strength == null ? null : Math.max(0, Math.min(100, Math.round(toNum(item.strength, 0))))
      }))
      .filter((item) => item.evidence_id)
  };
}

export function assertOrderMode(mode) {
  if (!MODE_SET.has(mode)) {
    throw new Error(`ORDER_MODE_NOT_PHASE_4_SAFE:${mode}`);
  }
}

export function assertOrderState(state) {
  if (!STATE_SET.has(state)) {
    throw new Error(`UNKNOWN_ORDER_STATE:${state}`);
  }
}

export function buildOrderId(input = {}) {
  const basis = {
    mode: input.mode || "research",
    strategy_version: input.strategyVersion || input.strategy_version || "unknown",
    side: cleanSide(input.side),
    symbol: String(input.symbol || "").trim(),
    contract_address: cleanAddress(input.contract_address),
    source_trade_id: input.source_trade_id || input.trade_id || null,
    requested_quantity: toNum(input.requested_quantity, 0),
    requested_notional_usd: toNum(input.requested_notional_usd, 0),
    planned_at: input.planned_at || input.ts || null,
    order_intent: input.order_intent || null
  };
  return `ord_${sha256(stableStringify(basis)).slice(0, 32)}`;
}

export function createLifecycleHistory(transitions, base = {}) {
  return transitions.map((transition, index) => {
    const state = typeof transition === "string" ? transition : transition.state;
    assertOrderState(state);
    return {
      state,
      ts: transition.ts || base.ts || null,
      sequence: index,
      actor: transition.actor || base.actor || "order_lifecycle",
      reason: transition.reason || null,
      ref: transition.ref || null
    };
  });
}

function transitionsForExecution(execution = null, riskRejected = false) {
  if (riskRejected) {
    return [
      { state: "planned", reason: "order_intent_created" },
      { state: "risk_rejected", reason: "paper_risk_rejected" }
    ];
  }
  const decision = String(execution?.decision || "filled").toLowerCase();
  if (decision === "partially_filled") {
    return ["planned", "approved", "submitted", "acknowledged", "partially_filled"];
  }
  if (decision === "rejected") {
    return [
      "planned",
      "approved",
      "submitted",
      "acknowledged",
      { state: "rejected", reason: execution?.rejection_reason || "simulated_execution_rejected" }
    ];
  }
  if (decision === "failed") {
    return ["planned", "approved", "submitted", "acknowledged", "failed"];
  }
  if (decision === "expired") {
    return ["planned", "approved", "submitted", "acknowledged", "expired"];
  }
  return ["planned", "approved", "submitted", "acknowledged", "filled"];
}

export function createOrderLifecycleRecord(input = {}) {
  const mode = input.mode || "research";
  assertOrderMode(mode);

  const trade = input.trade || {};
  const execution = input.execution || trade.simulated_execution || null;
  const requestedNotionalUsd = inferRequestedNotional(trade, execution);
  const requestedQuantity = inferRequestedQuantity(trade, execution, requestedNotionalUsd);
  const side = cleanSide(input.side || trade.side || execution?.side);
  const symbol = String(input.symbol || trade.symbol || "").trim();
  const contractAddress = cleanAddress(input.contract_address || trade.contract_address);
  const strategyVersion = input.strategyVersion || input.strategy_version || trade.strategy_version || "unknown";
  const plannedAt = input.planned_at || trade.ts || input.generated_at || null;
  const sourceTradeId = input.source_trade_id || trade.source_trade_id || trade.trade_id || null;
  const tradeId = input.trade_id || trade.trade_id || null;
  const orderIntent = input.order_intent || trade.reason || trade.trade_lifecycle || null;
  const orderId = input.order_id || buildOrderId({
    mode,
    strategyVersion,
    side,
    symbol,
    contract_address: contractAddress,
    source_trade_id: sourceTradeId,
    requested_quantity: requestedQuantity,
    requested_notional_usd: requestedNotionalUsd,
    planned_at: plannedAt,
    order_intent: orderIntent
  });
  const executionControlRef = input.execution_control_ref || buildLiquidityExecutionControlRef(execution?.liquidity_execution_control || null, {
    order_id: orderId
  });
  const evidencePacketId = extractEvidencePacketId(input);
  const evidenceRefs = extractEvidenceRefs(input);
  const evidenceSummary = extractEvidenceSummary(input);
  const stateHistory = createLifecycleHistory(
    input.transitions || transitionsForExecution(execution, Boolean(input.risk_rejected)),
    { ts: plannedAt, actor: "order_lifecycle" }
  );
  const currentState = stateHistory[stateHistory.length - 1]?.state || "planned";

  return {
    schema_version: ORDER_LIFECYCLE_SCHEMA_VERSION,
    order_id: orderId,
    order_id_basis: "sha256(mode,strategy_version,side,symbol,contract_address,source_trade_id,requested_size,planned_at,order_intent)",
    mode,
    live_submission_enabled: false,
    live_submission_attempted: false,
    trade_id: tradeId,
    source_trade_id: sourceTradeId,
    strategy_version: strategyVersion,
    side,
    symbol,
    contract_address: contractAddress,
    requested_quantity: requestedQuantity,
    requested_notional_usd: requestedNotionalUsd,
    order_intent: orderIntent,
    current_state: currentState,
    state_history: stateHistory,
    signal_snapshot_ref: input.signal_snapshot_ref || null,
    risk_decision_ref: input.risk_decision_ref || null,
    risk_decision_id: extractRiskDecisionId(input.risk_decision_ref || null),
    sizing_decision_ref: input.sizing_decision_ref || trade.paper_trade_ticket?.position_sizing || null,
    execution_plan_ref: input.execution_plan_ref || trade.paper_trade_ticket || null,
    execution_control_ref: executionControlRef,
    execution_control_id: extractExecutionControlId(execution, executionControlRef),
    quote_id: executionControlRef?.quote_id || execution?.quote_id || execution?.liquidity_execution_control?.quote_id || null,
    evidence_packet_id: evidencePacketId,
    evidence_summary: evidenceSummary,
    evidence_refs: evidenceRefs,
    simulated_execution: execution || null,
    venue_response_payloads: [],
    portfolio_mutation_ref: input.portfolio_mutation_ref || null,
    context: input.context || null
  };
}
