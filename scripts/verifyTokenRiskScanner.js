import assert from "assert";
import { buildTokenRiskScan, buildTokenRiskScanRef } from "./tokenRiskScanner.js";

const baseInput = {
  evaluated_at: "2026-04-28T12:00:00.000Z",
  mode: "paper",
  side: "buy",
  candidate_id: "cand-1",
  signal_snapshot_ref: { event_type: "signal_snapshot", cycle_id: "cycle-1" },
  token: {
    symbol: "SOLV",
    contract_address: "0xabc123",
    category: "meme",
    liquidity_usd: 250000,
    liquidity_quality: 62,
    fraud_risk: 12,
    holder_count: 4200,
    top_holder_pct: 18,
    verified_contract: true
  }
};

const one = buildTokenRiskScan(baseInput);
const two = buildTokenRiskScan(baseInput);

assert.equal(one.token_risk_scan_id, two.token_risk_scan_id, "token risk scan id should be stable");
assert.equal(one.decision, "pass", "healthy token should pass deterministic checks");
assert.equal(buildTokenRiskScanRef(one)?.token_risk_scan_id, one.token_risk_scan_id, "scan ref should preserve id");

const stablecoinBlocked = buildTokenRiskScan({
  ...baseInput,
  token: {
    ...baseInput.token,
    symbol: "USDC",
    category: "stablecoin"
  }
});
assert.equal(stablecoinBlocked.decision, "block", "stablecoin should be excluded");
assert(stablecoinBlocked.blockers.includes("stablecoin_excluded"), "stablecoin exclusion blocker missing");

const warned = buildTokenRiskScan({
  ...baseInput,
  token: {
    ...baseInput.token,
    fraud_risk: 45,
    liquidity_usd: 0,
    liquidity_quality: null,
    holder_count: 40,
    verified_contract: false
  }
});
assert.equal(warned.decision, "warn", "elevated but non-critical metadata should warn");
assert(warned.warnings.includes("fraud_risk_elevated"), "fraud warning missing");
assert(warned.warnings.includes("missing_liquidity_metadata"), "missing liquidity warning missing");
assert(warned.metadata_gaps.includes("liquidity_quality"), "metadata gaps should include liquidity quality");

console.log("verifyTokenRiskScanner: ok");
