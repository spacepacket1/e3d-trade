import assert from "assert";
import { simulateExecution } from "./executionSimulator.js";
import { buildLiquidityExecutionControls, buildLiquidityExecutionControlRef } from "./liquidityExecutionControls.js";
import { createOrderLifecycleRecord } from "./orderLifecycle.js";

const order = {
  ts: "2026-04-28T12:00:00.000Z",
  trade_id: "trade-phase-8",
  side: "buy",
  symbol: "TEST",
  contract_address: "0x0000000000000000000000000000000000000001",
  price: 1.25,
  notional_usd: 5000,
  liquidity_usd: 80000,
  spread_bps: 75,
  paper_trade_ticket: {
    max_slippage_bps: 500,
    allocation_usd: 5000
  }
};

const one = simulateExecution(order, { seed: "phase-8", feeBps: 10, slippageBps: 60 });
const two = simulateExecution(order, { seed: "phase-8", feeBps: 10, slippageBps: 60 });

assert.equal(one.execution_control_id, two.execution_control_id, "execution control id should be stable");
assert.equal(one.quote_id, two.quote_id, "quote id should be stable");
assert.equal(one.liquidity_execution_control.live_submission_enabled, false, "controls must not enable live submission");
assert.equal(one.liquidity_execution_control.route_plan.no_live_venue_adapter, true, "controls must not imply a live venue adapter");
assert.equal(one.liquidity_execution_control.liquidity_depth_bucket, "thin", "liquidity bucket should be deterministic");
assert(["blocked", "limited", "feasible"].includes(one.liquidity_execution_control.route_feasibility), "route feasibility should be represented");
assert(one.liquidity_execution_control.quote.expected_slippage_bps >= 0, "quote should include slippage warning field");
assert(one.liquidity_execution_control.gas.estimated_gas_bps >= 0, "quote should include gas field");
assert(one.liquidity_execution_control.mev.mev_risk_bps >= 0, "quote should include MEV field");

const explicit = buildLiquidityExecutionControls(order, one, { modelVersion: "verify-controls-v1" });
assert.equal(explicit.source_trade_id, "trade-phase-8", "control should link to source trade");
assert.equal(buildLiquidityExecutionControlRef(explicit).execution_control_id, explicit.control_id, "control ref should preserve id");

const lifecycle = createOrderLifecycleRecord({
  mode: "research",
  strategyVersion: "verify-phase-8",
  trade: order,
  execution: one,
  planned_at: order.ts
});
assert.equal(lifecycle.execution_control_id, one.execution_control_id, "order lifecycle should link execution control id");
assert.equal(lifecycle.quote_id, one.quote_id, "order lifecycle should link quote id");
assert.equal(lifecycle.live_submission_enabled, false, "order lifecycle must remain simulation-only");

console.log("verifyLiquidityExecutionControls: ok");
