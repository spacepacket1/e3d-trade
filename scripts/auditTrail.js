import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { evaluateLiveCapabilityStatus, LIVE_CAPABLE_MODES, TRADING_MODES } from "./custodyControls.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const AUDIT_LOG = path.join(LOG_DIR, "audit-events.jsonl");
const OPERATOR_ACTION_LOG = path.join(LOG_DIR, "operator-actions.jsonl");

export const AUDIT_TRAIL_SCHEMA_VERSION = "1.0";
export const OPERATOR_PERMISSION_POLICY_VERSION = "operator-permissions-v1";
export const OPERATOR_ROLES = Object.freeze(["viewer", "operator", "risk_admin", "deploy_admin"]);
export const OPERATOR_ACTION_TYPES = Object.freeze([
  "mode_change_request",
  "pipeline_start",
  "pipeline_stop",
  "pipeline_cycle_start",
  "pipeline_cycle_stop",
  "reset_request",
  "report_generation",
  "promotion_decision",
  "risk_override"
]);

const ROLE_SET = new Set(OPERATOR_ROLES);
const ACTION_SET = new Set(OPERATOR_ACTION_TYPES);
const LIVE_BLOCKED_MODES = Object.freeze(["live", ...LIVE_CAPABLE_MODES]);

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanText(value, fallback = null) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

export function buildAuditEventId(input = {}) {
  const basis = {
    schema_version: AUDIT_TRAIL_SCHEMA_VERSION,
    ts: input.ts || null,
    event_type: input.event_type || "operator_action",
    action_type: input.action_type || null,
    actor: input.actor || null,
    role: input.role || null,
    resource: input.resource || null,
    previous_state_hash: sha256(stableStringify(input.previous_state ?? null)),
    new_state_hash: sha256(stableStringify(input.new_state ?? null)),
    reason: input.reason || null,
    request_id: input.request_id || null,
    correlation_id: input.correlation_id || null
  };
  return `aud_${sha256(stableStringify(basis)).slice(0, 32)}`;
}

export function normalizeOperator(input = {}) {
  const role = cleanText(input.role || input.operator_role || process.env.E3D_OPERATOR_ROLE, "operator").toLowerCase();
  return {
    actor: cleanText(input.actor || input.operator || process.env.E3D_OPERATOR_ID, "local_operator"),
    role: ROLE_SET.has(role) ? role : "viewer"
  };
}

export function buildOperatorPermissionPolicy(input = {}) {
  const operator = normalizeOperator(input);
  const requestedMode = cleanText(input.mode || input.target_mode || "paper", "paper").toLowerCase();
  const actionType = cleanText(input.action_type || input.actionType || "mode_change_request", "mode_change_request");
  const approvals = asArray(input.approvals || input.approval_records);
  const liveCapability = evaluateLiveCapabilityStatus({
    mode: requestedMode,
    portfolio: input.portfolio || null,
    crypto_controls: input.crypto_controls || null
  });

  const checks = [];
  const addCheck = (code, status, detail, actual = null) => {
    checks.push({ code, status, detail, actual });
  };

  if (!ACTION_SET.has(actionType)) {
    addCheck("unknown_operator_action", "block", "Unknown operator action types fail closed.", { action_type: actionType });
  }

  if (actionType === "report_generation" && !["viewer", "operator", "risk_admin", "deploy_admin"].includes(operator.role)) {
    addCheck("viewer_or_higher_required", "block", "Report generation requires a known local role.", { role: operator.role });
  } else if (["pipeline_start", "pipeline_stop", "pipeline_cycle_start", "pipeline_cycle_stop", "reset_request", "mode_change_request"].includes(actionType)
    && !["operator", "risk_admin", "deploy_admin"].includes(operator.role)) {
    addCheck("operator_role_required", "block", "This operator action requires operator, risk_admin, or deploy_admin role.", { role: operator.role });
  } else if (actionType === "risk_override" && operator.role !== "risk_admin") {
    addCheck("risk_admin_required", "block", "Risk overrides require a risk_admin role.", { role: operator.role });
  } else if (actionType === "promotion_decision" && !["risk_admin", "deploy_admin"].includes(operator.role)) {
    addCheck("promotion_admin_required", "block", "Promotion decisions require risk_admin or deploy_admin role.", { role: operator.role });
  } else {
    addCheck("role_known", "pass", "Operator role is represented locally.", { role: operator.role });
  }

  if (LIVE_BLOCKED_MODES.includes(requestedMode)) {
    addCheck("live_capable_modes_fail_closed", "block", "Live-capable modes cannot be enabled by local operator records in this phase.", {
      requested_mode: requestedMode,
      live_capable_modes: LIVE_BLOCKED_MODES
    });
  } else if (![...TRADING_MODES, "stopped"].includes(requestedMode)) {
    addCheck("unknown_mode", "block", "Unknown trading modes fail closed.", { requested_mode: requestedMode });
  } else {
    addCheck("mode_supported", "pass", "Requested non-live mode is representable.", { requested_mode: requestedMode });
  }

  if (["mode_change_request", "risk_override"].includes(actionType)) {
    addCheck(
      "reason_required",
      cleanText(input.reason) ? "pass" : "block",
      "Mode changes and risk overrides require an operator reason.",
      { reason_present: Boolean(cleanText(input.reason)) }
    );
  }

  if (LIVE_CAPABLE_MODES.includes(requestedMode)) {
    const approvalRoles = new Set(approvals.map((approval) => cleanText(approval?.role)?.toLowerCase()).filter(Boolean));
    addCheck(
      "manual_live_approvals_required",
      approvalRoles.has("risk_admin") && approvalRoles.has("deploy_admin") ? "pass" : "block",
      "Live-capable promotion requires separate risk_admin and deploy_admin approval records, and still remains blocked by phase policy.",
      { approval_roles: [...approvalRoles].sort() }
    );
  }

  const blockers = checks.filter((check) => check.status === "block").map((check) => check.code);
  return {
    schema_version: AUDIT_TRAIL_SCHEMA_VERSION,
    policy_version: OPERATOR_PERMISSION_POLICY_VERSION,
    policy_id: `perm_${sha256(stableStringify({
      policy_version: OPERATOR_PERMISSION_POLICY_VERSION,
      operator,
      requested_mode: requestedMode,
      action_type: actionType,
      checks
    })).slice(0, 32)}`,
    operator,
    action_type: actionType,
    requested_mode: requestedMode,
    roles: OPERATOR_ROLES,
    supported_modes: TRADING_MODES,
    live_capable_modes: LIVE_BLOCKED_MODES,
    decision: blockers.length ? "block" : "allow",
    live_submission_enabled: false,
    checks,
    blockers,
    live_capability: liveCapability
  };
}

export function buildOperatorActionRecord(input = {}) {
  const ts = input.ts || nowIso();
  const operator = normalizeOperator(input);
  const actionType = cleanText(input.action_type || input.actionType, "operator_action");
  const permission = input.permission || buildOperatorPermissionPolicy({
    ...input,
    action_type: actionType,
    actor: operator.actor,
    role: operator.role
  });
  const record = {
    schema_version: AUDIT_TRAIL_SCHEMA_VERSION,
    audit_event_id: null,
    audit_event_id_basis: "sha256(schema_version,ts,event_type,action_type,actor,role,resource,previous_state_hash,new_state_hash,reason,request_id,correlation_id)",
    ts,
    event_type: "operator_action",
    action_type: actionType,
    actor: operator.actor,
    role: operator.role,
    permission_decision: permission.decision,
    permission_policy_id: permission.policy_id,
    permission_blockers: permission.blockers,
    reason: cleanText(input.reason),
    resource: cleanText(input.resource || input.subject || actionType),
    previous_state: input.previous_state ?? null,
    new_state: input.new_state ?? null,
    request_id: input.request_id || null,
    correlation_id: input.correlation_id || input.pipeline_run_id || input.report_id || null,
    live_submission_enabled: false,
    live_submission_attempted: false,
    metadata: input.metadata || null
  };
  record.audit_event_id = buildAuditEventId(record);
  return record;
}

export function appendAuditEvent(record, options = {}) {
  if (options.write === false) return record;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(AUDIT_LOG, `${JSON.stringify(record)}\n`);
  if (record?.event_type === "operator_action") {
    fs.appendFileSync(OPERATOR_ACTION_LOG, `${JSON.stringify(record)}\n`);
  }
  return record;
}

export function recordOperatorAction(input = {}, options = {}) {
  const record = buildOperatorActionRecord(input);
  return appendAuditEvent(record, options);
}

export function readOperatorActionRecords(options = {}) {
  const filePath = options.filePath || OPERATOR_ACTION_LOG;
  const maxRecords = Number.isFinite(Number(options.maxRecords)) ? Math.max(1, Number(options.maxRecords)) : 100;
  try {
    return fs.readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-maxRecords)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

