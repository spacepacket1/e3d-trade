// Offline checks for the settings hash, its stamping on new trade records, and the
// settings ledger report.
import assert from "assert/strict";
import crypto from "crypto";
import fs from "fs";

const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = () => {};

const {
  SETTINGS_HASH_VERSION, buildSettingsLedgerRecord, computeSettingsHash, computeSettingsHashSafe, stableStringify
} = await import("./settingsHash.js");
const { buildSettingsLedgerReport, diffSettings, formatSettingsLedger } = await import("./settingsLedger.js");
const { buildClosedPositions } = await import("./evalData.js");
const { buildEvalFixture } = await import("./evalFixture.js");
const { SETTINGS_DEFAULTS, executeSell, openPosition } = await import("../pipeline.js");

try {
  // 1. Stability.
  const base = { b: 2, a: 1, nested: { y: [1, 2, 3], x: "s" } };
  const reordered = { nested: { x: "s", y: [1, 2, 3] }, a: 1, b: 2 };
  assert.equal(computeSettingsHash(base), computeSettingsHash(reordered), "key order does not matter");
  assert.equal(computeSettingsHash(base), computeSettingsHash(JSON.parse(JSON.stringify(base))));
  assert.equal(stableStringify(base), '{"a":1,"b":2,"nested":{"x":"s","y":[1,2,3]}}');
  // Golden value: if this changes, every historical hash changes; bump SETTINGS_HASH_VERSION instead.
  assert.equal(computeSettingsHash({ a: 1 }), `${SETTINGS_HASH_VERSION}:${crypto.createHash("sha256").update('{"a":1}').digest("hex").slice(0, 16)}`);
  const defaultsHash = computeSettingsHash(SETTINGS_DEFAULTS);
  assert.match(defaultsHash, /^sh1:[0-9a-f]{16}$/);
  assert.equal(computeSettingsHash({ ...SETTINGS_DEFAULTS }), defaultsHash);
  assert.equal(computeSettingsHash(Object.fromEntries(Object.entries(SETTINGS_DEFAULTS).reverse())), defaultsHash);

  // 2. Change detection.
  const changed = new Set([defaultsHash]);
  for (const [key, value] of [
    ["min_liquidity_usd", 100001], ["min_buy_confidence", 66], ["fee_bps_per_side", 12.6], ["paper_mode", false],
    ["harvest_freeze_until", "2026-09-01T00:00:00Z"], ["default_target_multiples", [2.0, 1.5, 3.0]], ["brand_new_key", 1]
  ]) {
    const h = computeSettingsHash({ ...SETTINGS_DEFAULTS, [key]: value });
    assert.ok(!changed.has(h), `changing ${key} changes the hash`);
    changed.add(h);
  }
  const { min_buy_confidence: _drop, ...withoutKey } = SETTINGS_DEFAULTS;
  assert.notEqual(computeSettingsHash(withoutKey), defaultsHash, "removing a key changes the hash");

  // 3. Safe variant never throws; ledger record redacts secret-looking keys but hashes them.
  assert.equal(computeSettingsHashSafe(null), null);
  assert.equal(computeSettingsHashSafe([1, 2]), null);
  const circular = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => computeSettingsHashSafe(circular));
  const withSecret = { ...SETTINGS_DEFAULTS, api_key: "abc", rpc_url: "http://x" };
  const record = buildSettingsLedgerRecord(withSecret, "2026-10-01T00:00:00.000Z");
  assert.equal(record.settings.api_key, "[redacted]");
  assert.equal(record.settings.rpc_url, "[redacted]");
  assert.equal(record.settings.min_liquidity_usd, SETTINGS_DEFAULTS.min_liquidity_usd);
  assert.notEqual(computeSettingsHash({ ...withSecret, api_key: "def" }), record.settings_hash);

  // 4. New trade records carry settings_hash as an added field; trade_id is unaffected.
  const portfolio = {
    cash_usd: 1000, positions: {}, closed_trades: [], action_history: [], cooldowns: {}, stats: {},
    settings: { ...SETTINGS_DEFAULTS, min_trade_usd: 1 }
  };
  const expectedHash = computeSettingsHash(portfolio.settings);
  const candidate = {
    token: { symbol: "HASHT", contract_address: "0x123", category: "meme" },
    market_data: { current_price: 1 }, liquidity_data: { liquidity_usd: 1000000 },
    execution_data: { estimated_slippage_bps: 50 }, targets: { target_1: 1.2, target_2: 1.4, target_3: 1.6 }, invalidation_price: 0.9
  };
  const buy = await openPosition(portfolio, candidate, 100, "buy");
  assert.ok(buy);
  assert.equal(buy.settings_hash, expectedHash);
  const tradeIdFor = (t) => crypto.createHash("sha256").update(JSON.stringify({
    side: t.side || null, symbol: t.symbol || null, contract_address: t.contract_address || null, reason: t.reason || null,
    quantity: Number(t.quantity) || 0, price: Number(t.price) || 0, candidate_id: t.candidate_id || null, position_id: t.position_id || null,
    ts: t.ts || null, pipeline_run_id: null, cycle_id: null, cycle_index: null
  })).digest("hex");
  assert.equal(buy.trade_id, tradeIdFor(buy), "trade_id still derives only from the original fields");
  portfolio.positions.HASHT.current_price = 1;
  portfolio.positions.HASHT.market_value_usd = portfolio.positions.HASHT.quantity;
  const sell = await executeSell(portfolio, { symbol: "HASHT", fraction: 1, reason: "target_hit" });
  assert.ok(sell);
  assert.equal(sell.settings_hash, expectedHash);
  assert.equal(sell.trade_id, tradeIdFor(sell));
  assert.equal(portfolio.positions.HASHT, undefined, "existing sell behaviour unchanged");
  assert.ok(!("settings_hash" in (portfolio.closed_trades[0].paper_trade_ticket || {})), "only a top-level field is added");

  // 5. Settings ledger report on the synthetic fixture.
  const fixture = buildEvalFixture({ seed: "ledger" });
  const closed = buildClosedPositions(fixture.tradeEvents);
  const report = buildSettingsLedgerReport({ settingsLedgerRecords: fixture.settingsLedgerRecords, snapshotRecords: fixture.snapshotRecords, closedPositions: closed });
  assert.equal(report.versions.length, 2);
  assert.deepEqual(report.versions.map((v) => v.settings_hash), fixture.hashes);
  assert.equal(report.versions.reduce((s, v) => s + v.closed_trades, 0), closed.length);
  for (const v of report.versions) {
    const trades = closed.filter((t) => t.entry_settings_hash === v.settings_hash);
    const expectancy = trades.reduce((s, t) => s + t.pnl_usd, 0) / trades.length;
    assert.equal(v.expectancy_usd, Math.round(expectancy * 100) / 100);
    assert.ok(v.cycles > 0 && v.first_seen && v.last_seen);
  }
  assert.ok(report.versions[0].last_seen < report.versions[1].first_seen, "versions are ordered in time");
  assert.deepEqual(report.versions[1].changed_from_previous, [{ key: "default_stop_distance_pct", from: 0.2, to: 0.25 }]);
  assert.match(formatSettingsLedger(report), /changed default_stop_distance_pct: 0.2 -> 0.25/);

  // Trades from before the field existed are grouped as "unhashed".
  const legacy = buildClosedPositions([
    { ts: "2026-01-01T00:00:00Z", side: "buy", position_id: "p1", symbol: "OLD", price: 1 },
    { ts: "2026-01-02T00:00:00Z", side: "sell", position_id: "p1", symbol: "OLD", trade_lifecycle: "partial_sell", pnl_usd: 5, cost_portion_usd: 25 },
    { ts: "2026-01-03T00:00:00Z", side: "sell", position_id: "p1", symbol: "OLD", trade_lifecycle: "close", pnl_usd: -10, cost_portion_usd: 75 }
  ]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].pnl_usd, -5);
  assert.equal(legacy[0].net_return, -0.05);
  const legacyReport = buildSettingsLedgerReport({ closedPositions: legacy });
  assert.equal(legacyReport.versions[0].settings_hash, "unhashed");
  assert.equal(legacyReport.versions[0].closed_trades, 1);
  assert.deepEqual(diffSettings({ a: 1, b: [1] }, { a: 1, b: [2], c: 3 }), [{ key: "b", from: [1], to: [2] }, { key: "c", from: null, to: 3 }]);

  console.log("verifySettingsHash: ok");
} finally {
  fs.appendFileSync = originalAppendFileSync;
}
