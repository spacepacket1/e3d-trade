// Settings hash: a stable fingerprint of the effective desk settings
// (SETTINGS_DEFAULTS merged with portfolio overrides), so trades and candidate
// snapshots can be grouped by the parameter version that produced them.
//
// Pure, side-effect free, no I/O. Safe to import from pipeline.js.
import crypto from "crypto";

export const SETTINGS_HASH_VERSION = "sh1";
const SECRET_KEY_PATTERN = /(key|secret|password|passphrase|private|mnemonic|seed|wallet|custody|rpc|url|token_?auth|bearer|credential)/i;
const MAX_LEDGER_STRING = 200;
const MAX_LEDGER_ARRAY = 32;

// Key-order independent serialisation. Arrays keep their order (order is meaningful,
// e.g. default_target_multiples). Non-finite numbers and undefined serialise as null.
export function stableStringify(value, depth = 0) {
  if (depth > 12) return "\"[depth]\"";
  if (value === undefined || value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`).join(",")}}`;
}

// Throws on bad input; use computeSettingsHashSafe from hot paths.
export function computeSettingsHash(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings must be a plain object");
  }
  const digest = crypto.createHash("sha256").update(stableStringify(settings)).digest("hex");
  return `${SETTINGS_HASH_VERSION}:${digest.slice(0, 16)}`;
}

// Never throws; returns null when the settings cannot be hashed.
export function computeSettingsHashSafe(settings) {
  try {
    return computeSettingsHash(settings);
  } catch {
    return null;
  }
}

// A bounded, redacted copy of the settings for the ledger file. The hash is always
// computed over the full object; the copy only drops values whose key looks like a
// secret and truncates long strings/arrays so a record stays small.
export function redactSettingsForLedger(settings) {
  const out = {};
  if (!settings || typeof settings !== "object") return out;
  for (const key of Object.keys(settings).sort().slice(0, 300)) {
    const value = settings[key];
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
    } else if (value == null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value ?? null;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, MAX_LEDGER_STRING);
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, MAX_LEDGER_ARRAY).map((item) =>
        (typeof item === "number" || typeof item === "boolean" ? item : String(item).slice(0, MAX_LEDGER_STRING)));
    } else {
      out[key] = "[object omitted]";
    }
  }
  return out;
}

export function buildSettingsLedgerRecord(settings, ts = new Date().toISOString()) {
  const settingsHash = computeSettingsHash(settings);
  return {
    schema_version: "settings-ledger-v1",
    record_type: "settings_version",
    ts,
    settings_hash: settingsHash,
    settings: redactSettingsForLedger(settings)
  };
}
