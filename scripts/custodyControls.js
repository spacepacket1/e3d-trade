import crypto from "crypto";

export const CUSTODY_CONTROLS_SCHEMA_VERSION = "1.0";
export const LIVE_CAPABILITY_POLICY_VERSION = "live-capability-policy-v1";
export const TRADING_MODES = Object.freeze(["research", "paper", "shadow", "tiny_live", "scaled_live"]);
export const LIVE_CAPABLE_MODES = Object.freeze(["tiny_live", "scaled_live"]);
export const VENUE_TYPES = Object.freeze(["cex", "dex", "aggregator", "bridge"]);
export const WALLET_TIERS = Object.freeze(["hot", "warm", "cold"]);

const SECRET_KEY_PATTERN = /(secret|private[_-]?key|mnemonic|seed[_-]?phrase|api[_-]?key|password|passphrase|token|credential)$/i;

const DEFAULT_CONFIG = Object.freeze({
  live_trading_enabled: false,
  venues: [],
  wallets: [],
  signers: [],
  signing_policies: []
});

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanId(value, fallback = null) {
  return cleanText(value)?.toLowerCase() || fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function scanForSecretMaterial(value, path = []) {
  const findings = [];
  if (!value || typeof value !== "object") return findings;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const referenceOnly = /(_ref|Ref|reference)$/i.test(key);
    if (!referenceOnly && SECRET_KEY_PATTERN.test(key) && child != null && String(child).trim() !== "") {
      findings.push({
        code: "secret_material_in_config",
        path: childPath.join("."),
        detail: "Config must reference external credential handles only; raw secret-like values are forbidden."
      });
      continue;
    }
    findings.push(...scanForSecretMaterial(child, childPath));
  }

  return findings;
}

function sourceConfig(input = {}) {
  const explicit = input.crypto_controls || input.custody_controls || input.live_capability_controls || null;
  const settings = input.settings || input.portfolio?.settings || {};
  return {
    source: explicit ? "input.controls" : "portfolio.settings.crypto_controls",
    config: explicit || settings.crypto_controls || settings.custody_controls || settings.live_capability_controls || DEFAULT_CONFIG
  };
}

function normalizeVenue(record = {}) {
  const type = cleanId(record.type || record.venue_type);
  const id = cleanId(record.id || record.venue_id || record.name);
  const disabled = record.disabled !== false;
  return {
    venue_id: id,
    name: cleanText(record.name || id),
    type,
    enabled: !disabled,
    disabled,
    api_health_status: cleanId(record.api_health_status || record.api_health || "unknown"),
    deposits_enabled: record.deposits_enabled === true,
    withdrawals_enabled: record.withdrawals_enabled === true,
    incident_status: cleanId(record.incident_status || "unknown"),
    exposure_limit_usd: toNum(record.exposure_limit_usd, 0),
    order_size_limit_usd: toNum(record.order_size_limit_usd, 0),
    rate_limit_policy: record.rate_limit_policy && typeof record.rate_limit_policy === "object" ? record.rate_limit_policy : null
  };
}

function normalizeWallet(record = {}) {
  const tier = cleanId(record.tier || record.wallet_tier);
  const id = cleanId(record.id || record.wallet_id || record.name);
  const disabled = record.disabled !== false;
  return {
    wallet_id: id,
    label: cleanText(record.label || record.name || id),
    tier,
    enabled: !disabled,
    disabled,
    chain: cleanId(record.chain || "unknown"),
    address_ref: cleanText(record.address_ref || record.public_address_ref || record.address_label),
    exposure_limit_usd: toNum(record.exposure_limit_usd, 0),
    transaction_value_limit_usd: toNum(record.transaction_value_limit_usd, 0),
    nonce_tracking_enabled: record.nonce_tracking_enabled === true,
    stuck_transaction_policy: cleanText(record.stuck_transaction_policy)
  };
}

function normalizeSigner(record = {}) {
  const id = cleanId(record.id || record.signer_id || record.name);
  const disabled = record.disabled !== false;
  return {
    signer_id: id,
    type: cleanId(record.type || record.signer_type || "unknown"),
    enabled: !disabled,
    disabled,
    credential_ref: cleanText(record.credential_ref || record.external_credential_ref || record.env_credential_ref),
    max_transaction_value_usd: toNum(record.max_transaction_value_usd, 0),
    logs_request_metadata: record.logs_request_metadata === true,
    logs_transaction_hashes: record.logs_transaction_hashes === true,
    nonce_tracking_enabled: record.nonce_tracking_enabled === true
  };
}

function normalizeSigningPolicy(record = {}) {
  return {
    mode: cleanId(record.mode),
    signer_id: cleanId(record.signer_id),
    wallet_id: cleanId(record.wallet_id),
    venue_id: cleanId(record.venue_id),
    enabled: record.enabled === true,
    approval_required: record.approval_required === true,
    max_transaction_value_usd: toNum(record.max_transaction_value_usd, 0)
  };
}

function check(code, label, status, detail, actual = null) {
  return { code, label, status, detail, actual };
}

export function evaluateLiveCapabilityStatus(input = {}) {
  const requestedMode = cleanId(input.mode || input.target_mode || "paper");
  const { source, config } = sourceConfig(input);
  const secretFindings = scanForSecretMaterial(config);
  const venues = asArray(config?.venues).map(normalizeVenue).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const wallets = asArray(config?.wallets).map(normalizeWallet).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const signers = asArray(config?.signers).map(normalizeSigner).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const signingPolicies = asArray(config?.signing_policies).map(normalizeSigningPolicy).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const enabledVenues = venues.filter((venue) => venue.enabled);
  const enabledWallets = wallets.filter((wallet) => wallet.enabled);
  const enabledSigners = signers.filter((signer) => signer.enabled);
  const liveMode = LIVE_CAPABLE_MODES.includes(requestedMode);
  const globallyEnabled = config?.live_trading_enabled === true;
  const modePolicy = signingPolicies.find((policy) => policy.mode === requestedMode && policy.enabled) || null;

  const checks = [
    check("live_trading_disabled_by_policy", "Live trading global enable switch", "block", "Live trading is disabled by policy and cannot be enabled in Phase 6.", { requested_live_trading_enabled: globallyEnabled, effective_live_trading_enabled: false }),
    check("valid_venue_registry", "Venue registry", venues.length && venues.every((venue) => venue.venue_id && VENUE_TYPES.includes(venue.type)) ? "pass" : "block", "A future live mode requires explicit CEX/DEX/aggregator/bridge venue records.", { venue_count: venues.length, supported_types: VENUE_TYPES }),
    check("enabled_venue_required", "Enabled venue", enabledVenues.length ? "pass" : "block", "No venue is enabled for live execution.", { enabled_venue_count: enabledVenues.length }),
    check("venue_limits_required", "Venue limits", enabledVenues.length && enabledVenues.every((venue) => venue.exposure_limit_usd > 0 && venue.order_size_limit_usd > 0) ? "pass" : "block", "Every enabled venue requires exposure and order size limits.", { checked_venue_count: enabledVenues.length }),
    check("venue_health_required", "Venue health", enabledVenues.length && enabledVenues.every((venue) => venue.api_health_status === "healthy" && venue.incident_status === "clear") ? "pass" : "block", "Every enabled venue requires healthy API status and clear incident status.", { enabled_venue_count: enabledVenues.length }),
    check("wallet_registry_required", "Wallet registry", wallets.length && wallets.every((wallet) => wallet.wallet_id && WALLET_TIERS.includes(wallet.tier)) ? "pass" : "block", "A future live mode requires explicit hot, warm, or cold wallet records.", { wallet_count: wallets.length, supported_tiers: WALLET_TIERS }),
    check("enabled_wallet_required", "Enabled wallet", enabledWallets.length ? "pass" : "block", "No wallet is enabled for live signing.", { enabled_wallet_count: enabledWallets.length }),
    check("wallet_limits_required", "Wallet limits", enabledWallets.length && enabledWallets.every((wallet) => wallet.exposure_limit_usd > 0 && wallet.transaction_value_limit_usd > 0) ? "pass" : "block", "Every enabled wallet requires exposure and per-transaction value limits.", { checked_wallet_count: enabledWallets.length }),
    check("signer_required", "External signer", enabledSigners.length ? "pass" : "block", "No external signer policy is enabled.", { enabled_signer_count: enabledSigners.length }),
    check("signer_policy_required", "Signing policy", Boolean(modePolicy) ? "pass" : "block", `No enabled signing policy exists for ${requestedMode}.`, { requested_mode: requestedMode }),
    check("signer_limits_required", "Signer value limits", enabledSigners.length && enabledSigners.every((signer) => signer.max_transaction_value_usd > 0) ? "pass" : "block", "Every enabled signer requires a maximum transaction value.", { checked_signer_count: enabledSigners.length }),
    check("signing_audit_required", "Signing audit metadata", enabledSigners.length && enabledSigners.every((signer) => signer.logs_request_metadata && signer.logs_transaction_hashes) ? "pass" : "block", "Every enabled signer must log request metadata and transaction hashes.", { checked_signer_count: enabledSigners.length }),
    check("nonce_controls_required", "Nonce and stuck transaction controls", enabledWallets.length && enabledWallets.every((wallet) => wallet.nonce_tracking_enabled && wallet.stuck_transaction_policy) && enabledSigners.every((signer) => signer.nonce_tracking_enabled) ? "pass" : "block", "Wallets/signers require nonce tracking and stuck transaction policy metadata.", { checked_wallet_count: enabledWallets.length, checked_signer_count: enabledSigners.length }),
    check("secret_material_forbidden", "No raw secrets in config", secretFindings.length ? "block" : "pass", "Raw secrets, private keys, seed phrases, passwords, API keys, and credential values are forbidden in repo config.", { finding_count: secretFindings.length })
  ];

  const missingLiveControls = checks.filter((item) => item.status === "block").map((item) => item.code);
  const blockers = [
    ...missingLiveControls,
    ...(liveMode ? ["phase_6_live_submission_not_implemented"] : [])
  ];
  const statusBasis = {
    policy_version: LIVE_CAPABILITY_POLICY_VERSION,
    requested_mode: requestedMode,
    source,
    checks,
    live_capable_modes: LIVE_CAPABLE_MODES
  };

  return {
    schema_version: CUSTODY_CONTROLS_SCHEMA_VERSION,
    policy_version: LIVE_CAPABILITY_POLICY_VERSION,
    capability_status_id: `cap_${sha256(stableStringify(statusBasis)).slice(0, 32)}`,
    requested_mode: requestedMode,
    live_capable_mode: liveMode,
    live_trading_enabled: false,
    live_submission_enabled: false,
    live_submission_attempted: false,
    capability_status: blockers.length ? "blocked" : "disabled",
    decision: liveMode ? "block" : "allow_non_live_only",
    configuration_source: source,
    supported_modes: TRADING_MODES,
    live_capable_modes: LIVE_CAPABLE_MODES,
    checks,
    blockers: [...new Set(blockers)],
    secret_findings: secretFindings,
    controls: {
      venues,
      wallets,
      signers,
      signing_policies: signingPolicies
    },
    summary: blockers.length
      ? `Live-capable actions are blocked: ${[...new Set(blockers)].join(", ")}`
      : "Live-capable actions remain disabled by policy."
  };
}

export function assertLiveCapabilityBlocked(input = {}) {
  const status = evaluateLiveCapabilityStatus(input);
  if (LIVE_CAPABLE_MODES.includes(status.requested_mode)) {
    const err = new Error(`LIVE_CAPABILITY_BLOCKED:${status.blockers.join(",")}`);
    err.live_capability_status = status;
    throw err;
  }
  return status;
}
