import assert from "assert";
import { evaluateLiveCapabilityStatus } from "./custodyControls.js";
import { evaluateRiskDecision } from "./riskEngine.js";

const emptyPaper = evaluateLiveCapabilityStatus({ mode: "paper", portfolio: { settings: {} } });
assert.equal(emptyPaper.live_trading_enabled, false, "live trading must remain disabled");
assert.equal(emptyPaper.live_submission_enabled, false, "live submission must remain disabled");
assert.equal(emptyPaper.decision, "allow_non_live_only", "paper mode should not be blocked by custody controls");
assert(emptyPaper.blockers.includes("live_trading_disabled_by_policy"), "disabled-by-policy blocker should be auditable");

const secretConfig = evaluateLiveCapabilityStatus({
  mode: "tiny_live",
  crypto_controls: {
    live_trading_enabled: true,
    venues: [{ id: "venue-a", type: "cex", disabled: false }],
    api_key: "do-not-store"
  }
});
assert.equal(secretConfig.decision, "block", "live-capable mode must be blocked");
assert(secretConfig.blockers.includes("secret_material_forbidden"), "raw secret-like config must be rejected");
assert(secretConfig.secret_findings.some((finding) => finding.path === "api_key"), "secret finding path should be recorded without logging the value");

const liveRiskDecision = evaluateRiskDecision({
  mode: "tiny_live",
  enforcement_mode: "enforced",
  evaluated_at: "2026-04-28T12:00:00.000Z",
  portfolio: {
    cash_usd: 100000,
    positions: {},
    action_history: [],
    closed_trades: [],
    settings: {}
  },
  intent: {
    side: "buy",
    symbol: "ETH",
    contract_address: "0xeth",
    category: "layer1",
    strategy_version: "fixture-v1",
    requested_notional_usd: 1000,
    requested_quantity: 0.3,
    liquidity_usd: 1000000,
    spread_bps: 10,
    slippage_bps: 20
  }
});
assert.equal(liveRiskDecision.decision, "block", "risk engine must fail closed for live-capable mode");
assert(liveRiskDecision.blockers.includes("live_capability_blocked"), "risk engine should expose live capability blocker");
assert.equal(liveRiskDecision.live_capability.live_submission_enabled, false, "risk decision must not enable live submission");

console.log("verifyCustodyControls: ok");
