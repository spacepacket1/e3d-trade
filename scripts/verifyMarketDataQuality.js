import assert from "assert/strict";
import { buildMarketDataQuality, summarizeMarketDataQuality } from "./marketDataQuality.js";

const fresh = buildMarketDataQuality({
  evaluated_at: "2026-04-28T12:00:00.000Z",
  token: {
    symbol: "ETH",
    chain: "ethereum",
    contract_address: "0x1111111111111111111111111111111111111111"
  },
  market_data: {
    current_price: 3200,
    volume_24h_usd: 2400000,
    price_source: "e3d",
    price_timestamp: "2026-04-28T11:58:00.000Z"
  },
  liquidity_data: {
    liquidity_usd: 1800000,
    liquidity_source: "dexscreener",
    liquidity_timestamp: "2026-04-28T11:57:00.000Z"
  },
  execution_data: {
    spread_bps: 12,
    estimated_slippage_bps: 18,
    quote_source: "dexscreener",
    quote_timestamp: "2026-04-28T11:58:30.000Z"
  }
});

assert.equal(fresh.blockers.length, 0, "fresh snapshot should not block");
assert.equal(fresh.normalized.price_freshness, "fresh", "fresh snapshot should be fresh");
assert.equal(fresh.normalized.price_usd, 3200, "price should normalize");
assert.equal(fresh.normalized.liquidity_usd, 1800000, "liquidity should normalize");
assert.ok(fresh.data_quality_id.startsWith("mdq_"), "snapshot should have deterministic id");

const staleConflict = buildMarketDataQuality({
  evaluated_at: "2026-04-28T12:00:00.000Z",
  token: {
    symbol: "ALT",
    chain: "ethereum",
    contract_address: "0x2222222222222222222222222222222222222222",
    current_price: 1.75,
    price_source: "token_cache",
    price_timestamp: "2026-04-28T05:00:00.000Z"
  },
  market_data: {
    current_price: 1.0,
    volume_24h_usd: 1500000,
    price_source: "e3d",
    price_timestamp: "2026-04-28T05:00:00.000Z"
  },
  liquidity_data: {
    liquidity_usd: 50000,
    liquidity_source: "e3d",
    liquidity_timestamp: "2026-04-28T05:00:00.000Z"
  },
  execution_data: {
    spread_bps: 220,
    estimated_slippage_bps: 350,
    quote_source: "e3d",
    quote_timestamp: "2026-04-28T05:00:00.000Z"
  },
  api_errors: ["tokens_api_timeout"]
});

assert.ok(staleConflict.blockers.includes("stale_price"), "stale price should block");
assert.ok(staleConflict.blockers.includes("cross_source_price_disagreement"), "cross-source disagreement should block");
assert.equal(staleConflict.degraded_data_mode, true, "api errors should degrade data mode");

const summary = summarizeMarketDataQuality([fresh, staleConflict]);
assert.equal(summary.snapshot_count, 2, "summary should count snapshots");
assert.equal(summary.degraded_count, 1, "summary should count degraded snapshots");
assert.equal(summary.stale_count, 1, "summary should count stale snapshots");
assert.ok(summary.average_confidence < 100, "summary should reflect confidence penalties");

console.log(JSON.stringify({
  verified: true,
  snapshots: summary.snapshot_count,
  degraded_count: summary.degraded_count,
  stale_count: summary.stale_count
}, null, 2));
