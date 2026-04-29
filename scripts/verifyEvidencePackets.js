import assert from "assert/strict";
import {
  buildHarvestEvidencePacket,
  buildScoutEvidencePacket,
  evaluateScoutPacketEligibility,
  rankScoutPacket
} from "./evidencePackets.js";

const createdAt = "2026-04-28T12:00:00.000Z";

const strongScoutInput = {
  created_at: createdAt,
  strategy_version: "paper-pipeline-v1",
  source_agent: "scout",
  token: {
    symbol: "ALPHA",
    contract_address: "0xAlpha000000000000000000000000000000000001"
  },
  evidence: [
    { source_type: "story", source_ref: "story-1", label: "story_accumulation", direction: "bullish", strength: 78, summary: "ACCUMULATION cluster expanding across tracked wallets." },
    { source_type: "story", source_ref: "story-2", label: "story_breakout", direction: "bullish", strength: 73, summary: "BREAKOUT_CONFIRMED with broad participation." }
  ],
  market_data: {
    current_price: 1.24,
    change_24h_pct: 14.8,
    change_30m_pct: 4.1,
    volume_24h_usd: 980000,
    market_cap_usd: 12600000,
    price_source: "e3d",
    price_timestamp: "2026-04-28T11:55:00.000Z"
  },
  liquidity_data: {
    liquidity_usd: 420000,
    liquidity_source: "e3d",
    liquidity_timestamp: "2026-04-28T11:54:00.000Z"
  },
  execution_data: {
    estimated_slippage_bps: 48,
    spread_bps: 18,
    quote_source: "e3d",
    quote_timestamp: "2026-04-28T11:54:30.000Z"
  },
  flow: {
    flow_signal: "strong_accumulation",
    buy_sell_ratio_1h: 4.6,
    price_change_1h_pct: 6.2,
    source: "dexscreener",
    timestamp: "2026-04-28T11:56:00.000Z"
  },
  thesis: {
    thesis_id: "thesis-alpha",
    conviction: 81,
    direction: "bullish",
    summary: "Converging pre-pump thesis backed by thesis desk and fresh wallet intake."
  },
  market_data_quality: {
    data_quality_id: "mdq-alpha",
    evaluated_at: "2026-04-28T11:58:00.000Z",
    normalized: { confidence: 91 },
    blockers: [],
    warnings: [],
    degraded_data_mode: false
  },
  token_risk_scan: {
    token_risk_scan_id: "trs-alpha",
    evaluated_at: "2026-04-28T11:58:30.000Z",
    decision: "pass",
    blockers: [],
    warnings: []
  }
};

const strongScoutA = buildScoutEvidencePacket(strongScoutInput);
const strongScoutB = buildScoutEvidencePacket(JSON.parse(JSON.stringify(strongScoutInput)));

assert.equal(strongScoutA.evidence_packet_id, strongScoutB.evidence_packet_id, "packet id should be stable for normalized input");
assert.equal(strongScoutA.quality_score, strongScoutB.quality_score, "quality score should be deterministic");
assert.equal(strongScoutA.packet_type, "scout_candidate");
assert.equal(strongScoutA.symbol, "ALPHA");
assert.equal(strongScoutA.strategy_version, "paper-pipeline-v1");
assert.ok(strongScoutA.evidence_count >= 6, "strong scout should compact multiple evidence sources");
assert.ok(strongScoutA.market_evidence_count >= 3, "strong scout should include market, flow, and liquidity context");
assert.ok(strongScoutA.story_evidence_count >= 3, "strong scout should include story and thesis context");
assert.ok(strongScoutA.quality_score >= 75, "strong scout should score as high-quality");
assert.deepEqual(strongScoutA.blockers, []);
assert.deepEqual(strongScoutA.warnings, []);
assert.ok(strongScoutA.evidence.every((item) => item.summary.length <= 160), "packet summaries must stay compact");

const flowOnlyScout = buildScoutEvidencePacket({
  created_at: createdAt,
  token: {
    symbol: "FLOW",
    contract_address: "0xflow000000000000000000000000000000000001"
  },
  market_data: {
    current_price: 0.87,
    change_24h_pct: 7.2,
    volume_24h_usd: 510000,
    market_cap_usd: 8200000,
    price_source: "e3d",
    price_timestamp: "2026-04-28T11:57:00.000Z"
  },
  liquidity_data: {
    liquidity_usd: 240000,
    liquidity_source: "e3d",
    liquidity_timestamp: "2026-04-28T11:56:30.000Z"
  },
  flow: {
    flow_signal: "strong_accumulation",
    buy_sell_ratio_1h: 4.9,
    source: "dexscreener",
    timestamp: "2026-04-28T11:58:00.000Z"
  }
});

assert.equal(flowOnlyScout.packet_type, "scout_candidate");
assert.equal(flowOnlyScout.evidence_count, 3);
assert.ok(flowOnlyScout.warnings.includes("flow_only_candidate"));
assert.ok(flowOnlyScout.warnings.includes("missing_story_or_thesis_evidence"));
assert.deepEqual(flowOnlyScout.blockers, []);
const flowOnlyEligibility = evaluateScoutPacketEligibility(flowOnlyScout, {
  market_data: {
    volume_24h_usd: 510000,
    market_cap_usd: 8200000
  },
  liquidity_data: {
    liquidity_usd: 240000
  },
  flow: {
    flow_signal: "strong_accumulation",
    buy_sell_ratio_1h: 4.9
  }
});
assert.equal(flowOnlyEligibility.eligible, true);
assert.equal(flowOnlyEligibility.flow_only, true);

const weakScout = buildScoutEvidencePacket({
  created_at: createdAt,
  token: {
    symbol: "WEAK",
    contract_address: "0xweak000000000000000000000000000000000001"
  },
  evidence: [
    "watchlist mention only"
  ]
});

assert.equal(weakScout.evidence_count, 1);
assert.ok(weakScout.blockers.includes("under_evidenced"));
assert.ok(weakScout.warnings.includes("missing_market_evidence"));
assert.ok(weakScout.warnings.includes("missing_story_or_thesis_evidence") === false, "watchlist should count as story-side context");
const weakScoutEligibility = evaluateScoutPacketEligibility(weakScout, {
  evidence: ["watchlist mention only"]
});
assert.equal(weakScoutEligibility.eligible, false);
assert.ok(weakScoutEligibility.reasons.includes("requires_minimum_three_evidence_items"));

const harvestExit = buildHarvestEvidencePacket({
  created_at: createdAt,
  strategy_version: "paper-pipeline-v1",
  symbol: "EXIT",
  contract_address: "0xexit000000000000000000000000000000000001",
  position: {
    position_id: "pos-exit",
    quantity: 1200,
    avg_entry_price: 1.18,
    current_price: 0.91,
    market_value_usd: 1092,
    unrealized_pnl_pct: -22.9,
    holding_age_hours: 76
  },
  evidence: [
    { source_type: "story", source_ref: "story-risk-1", label: "story_treasury_distribution", direction: "risk", strength: 91, summary: "TREASURY_DISTRIBUTION into exchange-linked wallet." },
    { source_type: "story", source_ref: "story-risk-2", label: "story_liquidity_drain", direction: "bearish", strength: 84, summary: "LIQUIDITY_DRAIN and spread widening across primary pool." }
  ],
  market_data: {
    current_price: 0.91,
    change_24h_pct: -18.4,
    volume_24h_usd: 160000,
    market_cap_usd: 4100000,
    price_source: "e3d",
    price_timestamp: "2026-04-28T11:56:00.000Z"
  },
  liquidity_data: {
    liquidity_usd: 92000,
    liquidity_source: "e3d",
    liquidity_timestamp: "2026-04-28T11:55:30.000Z"
  },
  execution_data: {
    spread_bps: 215,
    estimated_slippage_bps: 290,
    quote_source: "e3d",
    quote_timestamp: "2026-04-28T11:55:45.000Z"
  },
  token_risk_scan: {
    token_risk_scan_id: "trs-exit",
    evaluated_at: "2026-04-28T11:58:00.000Z",
    decision: "block",
    blockers: ["fraud_risk_critical"],
    warnings: []
  },
  market_data_quality: {
    data_quality_id: "mdq-exit",
    evaluated_at: "2026-04-28T11:58:30.000Z",
    normalized: { confidence: 63 },
    blockers: [],
    warnings: ["cross_source_price_disagreement"],
    degraded_data_mode: false
  }
});

assert.equal(harvestExit.packet_type, "harvest_position");
assert.ok(harvestExit.risk_count >= 2, "harvest exit should preserve direct risk evidence");
assert.ok(harvestExit.bearish_count >= 1, "harvest exit should preserve direct bearish evidence");
assert.ok(harvestExit.blockers.includes("token_risk:fraud_risk_critical"));
assert.ok(!harvestExit.warnings.includes("no_direct_exit_evidence"));
const harvestExitPortfolio = harvestExit.evidence.find((item) => item.source_type === "portfolio");
assert.ok(harvestExitPortfolio, "harvest exit should include direct held-position context");
assert.match(harvestExitPortfolio.summary, /qty /);
assert.match(harvestExitPortfolio.summary, /avg /);
assert.match(harvestExitPortfolio.summary, /mv /);
assert.match(harvestExitPortfolio.summary, /pnl /);
assert.match(harvestExitPortfolio.summary, /age /);

const harvestNoExit = buildHarvestEvidencePacket({
  created_at: createdAt,
  symbol: "HOLD",
  contract_address: "0xhold000000000000000000000000000000000001",
  position: {
    position_id: "pos-hold",
    quantity: 400,
    avg_entry_price: 2.1,
    current_price: 2.24,
    market_value_usd: 896,
    unrealized_pnl_pct: 6.7,
    holding_age_hours: 31
  },
  market_data: {
    current_price: 2.24,
    change_24h_pct: 2.9,
    volume_24h_usd: 280000,
    market_cap_usd: 7300000,
    price_source: "e3d",
    price_timestamp: "2026-04-28T11:56:00.000Z"
  },
  liquidity_data: {
    liquidity_usd: 340000,
    liquidity_source: "e3d",
    liquidity_timestamp: "2026-04-28T11:55:00.000Z"
  },
  thesis: {
    conviction: 72,
    summary: "Original accumulation thesis remains intact."
  }
});

assert.ok(harvestNoExit.warnings.includes("no_direct_exit_evidence"));
assert.ok(harvestNoExit.blockers.every((item) => item !== "missing_portfolio_context"));
assert.ok(harvestNoExit.evidence.some((item) => item.source_type === "portfolio"));
assert.ok(harvestNoExit.evidence.some((item) => item.source_type === "thesis"), "harvest hold should preserve thesis support");

const strongScoutRank = rankScoutPacket(strongScoutA, {
  e3d_candidate: { convergence_score: 88 },
  thesis: { conviction: 81 },
  stories: strongScoutInput.evidence
});
const flowOnlyRank = rankScoutPacket(flowOnlyScout, {
  flow: { flow_signal: "strong_accumulation", buy_sell_ratio_1h: 4.9 },
  liquidity_data: { liquidity_usd: 240000 },
  market_data: { volume_24h_usd: 510000, market_cap_usd: 8200000 }
});
assert.ok(strongScoutRank.score > flowOnlyRank.score, "story-backed E3D candidate should rank ahead of flow-only fallback");

console.log(JSON.stringify({
  verified: true,
  strong_scout_quality_score: strongScoutA.quality_score,
  strong_scout_rank_score: strongScoutRank.score,
  flow_only_scout_warnings: flowOnlyScout.warnings,
  flow_only_scout_eligible: flowOnlyEligibility.eligible,
  weak_scout_blockers: weakScout.blockers,
  weak_scout_eligible: weakScoutEligibility.eligible,
  harvest_exit_blockers: harvestExit.blockers,
  harvest_hold_warnings: harvestNoExit.warnings
}, null, 2));
