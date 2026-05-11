import assert from "assert/strict";
import {
  buildFrequentAddressRepairWarning,
  buildPipelineWarningsForCycle
} from "../pipeline.js";
import {
  buildEvidenceDiagnosticsEvent,
  buildScoutEvidenceDiagnostics
} from "./evidenceDiagnostics.js";

const scoutDiagnostics = buildScoutEvidenceDiagnostics({
  input_candidate_count: 6,
  llm_batches: [
    { prompt_chars: 1200, prompt_tokens: 320, completion_tokens: 90, total_tokens: 410, duration_ms: 800 }
  ],
  address_repairs_in_cycle: 2,
  candidates: [
    { evidence: ["story signal", "market_data", "flow_signal"] },
    { evidence: ["story signal", "market_data", "flow_signal"] },
    { evidence: ["story signal", "market_data", "flow_signal"] },
    { evidence: ["story signal", "market_data", "flow_signal"] },
    { evidence: ["story signal", "market_data", "flow_signal"] },
    { evidence: ["story signal", "market_data", "flow_signal"] }
  ],
  stories_checked: [{ type: "ACCUMULATION" }]
});

assert.equal(scoutDiagnostics.address_repairs_in_cycle, 2);
assert.equal(scoutDiagnostics.candidates_returned, 6);

const event = buildEvidenceDiagnosticsEvent({
  cycle_id: "cycle-address-repair",
  pipeline_run_id: "run-address-repair",
  scout: scoutDiagnostics
});
assert.equal(event.scout.address_repairs_in_cycle, 2);

const warning = buildFrequentAddressRepairWarning(scoutDiagnostics);
assert.equal(warning?.code, "frequent_address_repairs");
assert.equal(warning?.address_repairs_in_cycle, 2);
assert.equal(warning?.candidates_returned, 6);
assert.equal(warning?.address_repair_rate, 0.3333);

const warnings = buildPipelineWarningsForCycle({ scoutEvidenceDiagnostics: scoutDiagnostics });
assert.equal(warnings.length, 1);
assert.equal(warnings[0].code, "frequent_address_repairs");

const healthyWarnings = buildPipelineWarningsForCycle({
  scoutEvidenceDiagnostics: buildScoutEvidenceDiagnostics({
    address_repairs_in_cycle: 1,
    candidates: [
      { evidence: ["story", "market_data", "flow_signal"] },
      { evidence: ["story", "market_data", "flow_signal"] },
      { evidence: ["story", "market_data", "flow_signal"] },
      { evidence: ["story", "market_data", "flow_signal"] }
    ]
  })
});
assert.equal(healthyWarnings.length, 0);

console.log("verifyAddressRepairTelemetry: ok");
