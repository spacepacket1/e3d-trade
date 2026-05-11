import assert from "assert/strict";
import { buildFunnelRollup } from "../server.js";

function transitionMap(report) {
  return new Map(report.transitions.map((transition) => [`${transition.from}->${transition.to}`, transition]));
}

const report = buildFunnelRollup({ window: "24h" });
assert.equal(report.window, "24h");
assert.equal(typeof report.generated_at, "string");
assert.equal(Array.isArray(report.transitions), true);
assert.equal(report.transitions.length, 10);
assert.equal(typeof report.totals?.trades_opened, "number");
assert.equal(typeof report.totals?.cycles_observed, "number");
assert.equal(Array.isArray(report.top_block_reasons?.shortlist), true);
assert.equal(Array.isArray(report.top_block_reasons?.risk), true);
assert.equal(Array.isArray(report.top_block_reasons?.executor), true);

const cycleId = "4e3438a1-7016-453b-8563-65ec341c09e8";
const cycleReport = buildFunnelRollup({ window: "24h", cycleId });
const cycleTransitions = transitionMap(cycleReport);

assert.equal(cycleReport.totals.cycles_observed, 1);
assert.equal(cycleTransitions.get("universe_filtered->shortlist_built")?.count_out, 2);
assert.equal(cycleTransitions.get("shortlist_built->shortlist_blocked")?.count_out, 5);
assert.equal(cycleTransitions.get("llm_input->llm_returned")?.count_out, 1);
assert.equal(cycleTransitions.get("llm_returned->risk_input")?.count_out, 0);
assert.deepEqual(cycleReport.top_block_reasons.shortlist, [
  { reason_code: "zero_liquidity_untradeable", count: 3 },
  { reason_code: "flow_only_thresholds_not_met", count: 2 }
]);

console.log("verifyFunnelRollup: ok");
