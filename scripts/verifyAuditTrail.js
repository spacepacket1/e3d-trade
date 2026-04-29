import assert from "assert";
import {
  buildAuditEventId,
  buildOperatorActionRecord,
  buildOperatorPermissionPolicy
} from "./auditTrail.js";

const baseAction = {
  ts: "2026-04-28T12:00:00.000Z",
  action_type: "pipeline_start",
  actor: "fixture_operator",
  role: "operator",
  reason: "fixture pipeline start",
  resource: "pipeline",
  new_state: {
    mode: "paper",
    interval_seconds: 300
  }
};

const one = buildOperatorActionRecord(baseAction);
const two = buildOperatorActionRecord(baseAction);
assert.equal(one.audit_event_id, two.audit_event_id, "same operator action input must produce a stable audit_event_id");
assert.equal(one.live_submission_enabled, false, "audit records must not enable live submission");
assert.equal(one.permission_decision, "allow", "operator can start local paper pipeline");
assert.equal(buildAuditEventId(one), one.audit_event_id, "audit_event_id should be reproducible from the record");

const missingReason = buildOperatorPermissionPolicy({
  action_type: "mode_change_request",
  mode: "shadow",
  actor: "fixture_operator",
  role: "operator"
});
assert.equal(missingReason.decision, "block", "mode changes without reasons must fail closed");
assert(missingReason.blockers.includes("reason_required"), "reason blocker should be explicit");

const livePolicy = buildOperatorPermissionPolicy({
  action_type: "mode_change_request",
  mode: "tiny_live",
  actor: "fixture_operator",
  role: "deploy_admin",
  reason: "fixture live mode request",
  approvals: [
    { actor: "risk", role: "risk_admin", ts: "2026-04-28T12:00:00.000Z" },
    { actor: "deploy", role: "deploy_admin", ts: "2026-04-28T12:01:00.000Z" }
  ]
});
assert.equal(livePolicy.decision, "block", "tiny_live must remain blocked by phase policy");
assert.equal(livePolicy.live_submission_enabled, false, "operator policy must never enable live submission");
assert(livePolicy.blockers.includes("live_capable_modes_fail_closed"), "live-capable mode blocker should be explicit");
assert(livePolicy.live_capability.blockers.includes("phase_6_live_submission_not_implemented"), "custody live capability blocker should be consumed");

const riskOverride = buildOperatorPermissionPolicy({
  action_type: "risk_override",
  mode: "paper",
  actor: "fixture_operator",
  role: "operator",
  reason: "fixture risk override"
});
assert.equal(riskOverride.decision, "block", "risk overrides require risk_admin role");
assert(riskOverride.blockers.includes("risk_admin_required"), "risk override role blocker should be explicit");

console.log("verifyAuditTrail: ok");
