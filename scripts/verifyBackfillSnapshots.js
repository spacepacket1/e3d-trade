// Offline checks for scripts/backfillSnapshots.js and the --include-backfilled paths of
// baselineCompare / settingsLedger / snapshotCompleteness, on a small synthetic history.
// Does not import pipeline.js, read logs/ or touch the network; temp files only.
import assert from "assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const bf = await import("./backfillSnapshots.js");
const { compareBaselines, dropPriceSpikes, buildMarketIndex } = await import("./baselineCompare.js");
const { buildCompletenessReport, formatCompleteness } = await import("./snapshotCompleteness.js");
const { buildSettingsLedgerReport, formatSettingsLedger } = await import("./settingsLedger.js");
const evalData = await import("./evalData.js");
const { buildEvalFixture } = await import("./evalFixture.js");
const { SNAPSHOT_STAGES } = await import("./candidateSnapshots.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WETH = evalData.WETH_ADDRESS;
const A = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
const FORBIDDEN = /"(quantity|cash_usd|equity_usd|cost_basis_usd|cost_usd|pnl_usd|proceeds_usd|wallet|wallet_address|private_key|portfolio_snapshot|open_positions)"/;

function ev(type, cycleId, ts, payload, extra = {}) {
  return { event_id: `${type}-${cycleId}-${ts}`, schema_version: "1.0.0", ts, event_type: type, actor: "test", pipeline_run_id: "run-1", cycle_id: cycleId, cycle_index: 1, market_regime: "neutral", payload, ...extra };
}
const token = (n, sym) => ({ symbol: sym, contract_address: A(n), chain: "ethereum" });
const md = (price, extra = {}) => ({ current_price: price, market_cap_usd: 5e6, volume_24h_usd: 2e5, change_24h_pct: 3, ...extra });
const holdingsPayload = (ethPrice, extraMarks = []) => ({
  // portfolio_snapshot / quantity are present in real history and must never be copied.
  portfolio_snapshot: { cash_usd: 1234, equity_usd: 5678, open_positions: 2 },
  portfolio_intelligence: {
    holdings: [
      { token: { symbol: "WETH", contract_address: WETH }, market_data: { current_price: ethPrice }, position: { quantity: 3.3, cost_basis_usd: 999, current_price: ethPrice },
        market_trends: { gainers: extraMarks.map(([n, p]) => ({ contract_address: A(n), current_price: p })), losers: [] } }
    ]
  }
});

const settingsV1 = { paper_mode: true, max_open_positions: 8, target_partial_pct: 0.25 };
const settingsV2 = { ...settingsV1, default_stop_distance_pct: 0.25 };

// Cycle c1: candidates 1..4; 1 gate-rejected, 2 vetoed by the LLM risk reviewer,
// 3 approved and bought, 4 desk-kept with no risk decision. Plus an exit proposal (ignored).
const c1 = "cycle-1";
const c2 = "cycle-2";
const c3 = "cycle-3"; // no cycle_end (aborted)
const events = [
  ev("cycle_start", c1, "2026-04-01T00:00:00.000Z", { settings: settingsV1, ...holdingsPayload(2000, [[5, 1.5]]) }),
  ev("candidate", c1, "2026-04-01T00:01:00.000Z", { token: token(1, "AAA"), market_data: md(1.0), liquidity_data: { liquidity_usd: 300000 }, execution_data: { estimated_slippage_bps: 80 }, fraud_risk: 10, portfolio_snapshot: { cash_usd: 1 } }),
  ev("candidate", c1, "2026-04-01T00:01:00.000Z", { token: token(2, "BBB"), market_data: md(2.0), liquidity_data: { liquidity_usd: 50000 }, execution_data: {} }),
  ev("candidate", c1, "2026-04-01T00:01:00.000Z", { token: token(3, "CCC"), market_data: md(3.0), liquidity_data: { liquidity_usd: 2e6 }, execution_data: { estimated_slippage_bps: 40 } }),
  ev("candidate", c1, "2026-04-01T00:01:00.000Z", { token: token(4, "DDD"), market_data: md(4.0), liquidity_data: { liquidity_usd: 1e5 } }),
  ev("risk_decision", c1, "2026-04-01T00:02:00.000Z", { decision: "reject", handoff_to_executor: false,
    risk_review: { decision: "reject", deterministic_gate: true, reason_codes: ["liquidity_below_min"] },
    proposal: { action: "buy", token: token(1, "AAA"), market_data: md(1.0), liquidity_data: { liquidity_usd: 300000 }, confidence: 55, evidence: [{}, {}], _fragility_score: 0.4 } }),
  ev("risk_decision", c1, "2026-04-01T00:02:00.000Z", { decision: "reject", handoff_to_executor: false,
    risk_review: { decision: "reject", reason_codes: ["thesis_weak"] },
    proposal: { action: "buy", token: token(2, "BBB"), market_data: md(2.0), confidence: 61, evidence: [{}] } }),
  ev("risk_decision", c1, "2026-04-01T00:02:00.000Z", { decision: "paper_trade", handoff_to_executor: true,
    risk_review: { decision: "paper_trade", reason_codes: ["ok"] },
    proposal: { action: "buy", token: token(3, "CCC"), market_data: md(3.0), liquidity_data: { liquidity_usd: 2e6 }, execution_data: { estimated_slippage_bps: 40 }, confidence: 72, evidence: [{}, {}, {}] } }),
  ev("risk_decision", c1, "2026-04-01T00:02:00.000Z", { decision: "approve_for_executor", handoff_to_executor: true,
    risk_review: { decision: "approve_for_executor" }, proposal: { action: "exit", token: token(9, "OLD"), market_data: md(9.0) } }),
  ev("trade", c1, "2026-04-01T00:03:00.000Z", { trade: { side: "buy", symbol: "CCC", contract_address: A(3), quantity: 1234, price: 3.01, cost_usd: 3714, trade_lifecycle: "open", position_id: "p1" } }),
  ev("cycle_end", c1, "2026-04-01T00:05:00.000Z", { stats: { equity_usd: 1 }, ...holdingsPayload(2010, [[3, 3.1]]) }),
  ev("arbitrage_signal", c1, "2026-04-01T00:04:00.000Z", { symbol: "ZZZ" }),
  ev("cycle_start", c2, "2026-04-02T00:00:00.000Z", { settings: settingsV2, portfolio_intelligence: { holdings: [] } }),
  ev("candidate", c2, "2026-04-02T00:01:00.000Z", { token: token(3, "CCC"), market_data: md(3.3) }),
  ev("cycle_end", c2, "2026-04-02T00:05:00.000Z", {}),
  ev("cycle_start", c3, "2026-04-03T00:00:00.000Z", { settings: settingsV2 }),
  ev("candidate", c3, "2026-04-03T00:01:00.000Z", { token: token(1, "AAA"), market_data: md(0.9) })
];

// 1. In-memory backfill: stages, provenance, nulls, settings hash, ETH, no forbidden fields.
const { snapshotRecords, ledgerRecords, stats } = bf.backfillFromEvents(events);
assert.equal(stats.cycles, 3);
for (const r of snapshotRecords) {
  assert.equal(r.provenance, "backfilled", "every record is labelled backfilled");
  assert.equal(r.schema_version, "candidate-snapshot-v1");
  assert.ok(!FORBIDDEN.test(JSON.stringify(r)), `no wallet/cash/quantity/PnL fields: ${JSON.stringify(r).slice(0, 120)}`);
  assert.ok(r.settings_hash === null || r.settings_hash.startsWith("bf1:"), "backfilled hashes never look live");
}
const cand = (cycle, n) => snapshotRecords.find((r) => r.record_type === "candidate" && r.cycle_id === cycle && r.token_address === A(n));
assert.equal(cand(c1, 1).stage, "gate_rejected");
assert.deepEqual(cand(c1, 1).reason_codes, ["liquidity_below_min"]);
assert.equal(cand(c1, 1).confidence, 55);
assert.equal(cand(c1, 1).evidence_count, 2);
assert.equal(cand(c1, 1).fraud_risk, 10, "candidate-event fields survive a later stage without them");
assert.equal(cand(c1, 2).stage, "risk_vetoed");
assert.equal(cand(c1, 2).slippage_bps, null, "unknown stays null, never a default");
assert.equal(cand(c1, 3).stage, "bought");
assert.equal(cand(c1, 3).confidence, 72);
assert.equal(cand(c1, 4).stage, "price_rejected");
assert.deepEqual(cand(c1, 4).reason_codes, ["backfill_no_risk_decision"]);
assert.equal(cand(c1, 4).confidence, null);
assert.equal(snapshotRecords.filter((r) => r.record_type === "candidate" && r.cycle_id === c1).length, 4, "exit proposal ignored");
const cyc1 = snapshotRecords.find((r) => r.record_type === "cycle" && r.cycle_id === c1);
assert.equal(cyc1.eth_price_usd, 2000, "ETH from the WETH mark of the same cycle");
assert.equal(cyc1.universe_captured, false);
assert.equal(cyc1.settings_scope, "portfolio_overrides_only");
assert.equal(cyc1.stage_counts.bought, 1);
for (const stage of ["universe_blocked", "ranked_out", "shortlisted", "desk_filtered"]) assert.equal(cyc1.stage_counts[stage], 0, `${stage} is not invented`);
const cyc2 = snapshotRecords.find((r) => r.record_type === "cycle" && r.cycle_id === c2);
assert.equal(cyc2.eth_price_usd, null, "no WETH mark -> null ETH price");
const marks1 = snapshotRecords.filter((r) => r.record_type === "price_marks" && r.cycle_id === c1);
assert.equal(marks1.length, 2, "cycle_start and cycle_end mark records");
assert.ok(marks1.some((r) => r.mark_point === "cycle_end" && r.ts === "2026-04-01T00:05:00.000Z"));
assert.ok(marks1.every((r) => r.marks.every((m) => m.length === 3)), "marks are [address, price, liquidity] only");
assert.ok(!marks1.some((r) => r.marks.some((m) => m[1] === 3.01)), "trade fill prices are not used as marks");
assert.equal(cyc1.settings_hash, bf.backfilledSettingsHash(settingsV1));
assert.notEqual(cyc1.settings_hash, cyc2.settings_hash);
assert.equal(ledgerRecords.length, 2, "one ledger record per distinct settings version");
assert.ok(ledgerRecords.every((r) => r.provenance === "backfilled" && r.settings_scope === "portfolio_overrides_only"));
assert.ok(snapshotRecords.some((r) => r.cycle_id === c3 && r.record_type === "cycle"), "a cycle without cycle_end is still flushed");

// 2. Streaming file version matches the in-memory one; CLI refuses to overwrite inputs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-backfill-"));
try {
  const input = path.join(tmp, "training-events.jsonl");
  fs.writeFileSync(input, events.map((e) => JSON.stringify(e)).join("\n") + "\n{\"event_type\":\"trade\", broken\n");
  const before = fs.readFileSync(input, "utf8");
  const out = path.join(tmp, "out", "snap.backfilled.jsonl");
  const ledgerOut = path.join(tmp, "out", "ledger.backfilled.jsonl");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const totals = await bf.backfillFile({ input, out, ledgerOut });
  assert.equal(totals.malformed, 1);
  assert.equal(totals.cycles, 3);
  const streamed = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const norm = (rs) => rs.map((r) => JSON.stringify(r)).sort();
  assert.deepEqual(norm(streamed), norm(snapshotRecords), "streamed output equals in-memory output");
  assert.equal(fs.readFileSync(input, "utf8"), before, "input is never modified");

  const script = path.join(__dirname, "backfillSnapshots.js");
  const same = spawnSync(process.execPath, [script, `--input=${input}`, `--out=${input}`, `--ledger-out=${ledgerOut}`, "--force"], { encoding: "utf8" });
  assert.notEqual(same.status, 0, "refuses to write over its input");
  assert.equal(fs.readFileSync(input, "utf8"), before);
  const exists = spawnSync(process.execPath, [script, `--input=${input}`, `--out=${out}`, `--ledger-out=${ledgerOut}`], { encoding: "utf8" });
  assert.notEqual(exists.status, 0, "refuses to overwrite an existing output without --force");
  const forced = spawnSync(process.execPath, [script, `--input=${input}`, `--out=${out}`, `--ledger-out=${ledgerOut}`, "--force"], { encoding: "utf8" });
  assert.equal(forced.status, 0, forced.stderr);

  // 3. Loaders: the include flag gates backfilled data; live records win on overlap.
  const none = await evalData.loadSnapshotsWithBackfill({ include: false }, path.join(tmp, "missing-live.jsonl"));
  assert.equal(none.records.length, 0);
  const withBf = await evalData.loadSnapshotsWithBackfill({ include: true, snapshots: out }, path.join(tmp, "missing-live.jsonl"));
  assert.equal(withBf.records.length, snapshotRecords.length);
  assert.equal(withBf.provenance.backfilled_cycles, 3);
  const opts = evalData.backfillOptionsFromArgs({ "backfilled-snapshots": out });
  assert.equal(opts.include, true);
  assert.equal(evalData.backfillOptionsFromArgs({}).include, false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  const live = [{ record_type: "cycle", cycle_id: c1, ts: "2026-04-01T00:00:00.000Z" }];
  const merged = evalData.mergeSnapshotSources(live, snapshotRecords);
  assert.ok(merged.records.filter((r) => r.cycle_id === c1).every((r) => r.provenance === undefined), "live cycle replaces its backfilled copy");
  assert.ok(merged.provenance.backfilled_dropped_overlapping_live > 0);
  assert.equal(evalData.mergeSnapshotSources(live, [{ record_type: "cycle", cycle_id: "x" }]).provenance.backfilled_records, 0, "unlabelled records are not accepted as backfilled");
}

// 4. baselineCompare labels backfilled data and is unchanged without it.
{
  const f = buildEvalFixture({ seed: "bf", days: 20 });
  const closed = evalData.buildClosedPositions(f.tradeEvents);
  const liveOnly = compareBaselines({ snapshotRecords: f.snapshotRecords, closedPositions: closed, settingsLedgerRecords: f.settingsLedgerRecords }, { seed: 3, draws: 200 });
  assert.equal(liveOnly.data_provenance, "live");
  assert.equal(liveOnly.inputs.backfilled_snapshot_cycles, 0);
  const asBackfilled = f.snapshotRecords.map((r) => ({ ...r, provenance: "backfilled" }));
  const bfOnly = compareBaselines({ snapshotRecords: asBackfilled, closedPositions: closed, settingsLedgerRecords: f.settingsLedgerRecords }, { seed: 3, draws: 200 });
  assert.equal(bfOnly.data_provenance, "backfilled");
  assert.equal(bfOnly.baselines.random_entry.excess_mean, liveOnly.baselines.random_entry.excess_mean, "the label does not change the numbers");
  assert.equal(bfOnly.baselines.random_entry.backfilled_cycle_pairs, bfOnly.baselines.random_entry.n);
  assert.equal(bfOnly.baselines.equal_weight_approved.baseline_backfilled_entries, bfOnly.baselines.equal_weight_approved.baseline_entries);
  const half = f.snapshotRecords.map((r) => (r.cycle_id.endsWith("0") ? { ...r, provenance: "backfilled" } : r));
  assert.equal(compareBaselines({ snapshotRecords: half, closedPositions: closed }, { seed: 3, draws: 50 }).data_provenance, "live+backfilled");
}

// 5. Price spike filter: drops isolated unit glitches (also at the ends), keeps real moves.
{
  const pts = (prices) => prices.map((price, i) => ({ ms: i * 1000, price }));
  assert.deepEqual(dropPriceSpikes(pts([1, 1.1, 5000, 1.2, 1.3]), 10).kept.map((p) => p.price), [1, 1.1, 1.2, 1.3]);
  assert.deepEqual(dropPriceSpikes(pts([1e-7, 1.0, 1.1, 1.2]), 10).kept.map((p) => p.price), [1.0, 1.1, 1.2], "first-point glitch");
  assert.deepEqual(dropPriceSpikes(pts([1.0, 1.1, 1.2, 900]), 10).kept.map((p) => p.price), [1.0, 1.1, 1.2], "last-point glitch");
  assert.deepEqual(dropPriceSpikes(pts([1, 1, 20, 21, 22]), 10).kept.map((p) => p.price), [1, 1, 20, 21, 22], "a sustained move is kept");
  assert.equal(dropPriceSpikes(pts([1, 50, 1]), null).kept.length, 3, "off by default");
  const recs = [
    { record_type: "candidate", cycle_id: "k1", ts: "2026-01-01T00:00:00Z", token_address: A(7), stage: "approved", price_usd: 1e-6 },
    { record_type: "price_marks", cycle_id: "k2", ts: "2026-01-01T01:00:00Z", marks: [[A(7), 1.0, null]] },
    { record_type: "price_marks", cycle_id: "k3", ts: "2026-01-01T02:00:00Z", marks: [[A(7), 1.05, null]] }
  ];
  const idx = buildMarketIndex(recs, { spikeRatio: 10 });
  assert.equal(idx.spikes.points_dropped, 1);
  assert.equal(idx.spikes.candidates_dropped, 1, "a candidate priced at a glitch is not used as an entry");
  assert.equal(buildMarketIndex(recs).spikes.points_dropped, 0);
}

// 6. snapshotCompleteness keeps the live share separate from backfilled coverage.
{
  const cycleStarts = events.filter((e) => e.event_type === "cycle_start").map((e) => ({ cycle_id: e.cycle_id, ts: e.ts }));
  const live = buildCompletenessReport({ cycleStarts, snapshotRecords: [] });
  assert.equal(live.completeness_share, 0);
  assert.equal(live.backfilled, undefined);
  const r = buildCompletenessReport({ cycleStarts, snapshotRecords });
  assert.equal(r.completeness_share, 0, "backfill never inflates the live completeness figure");
  assert.equal(r.backfilled.cycles_with_backfilled_snapshot, 3);
  assert.equal(r.backfilled.completeness_share_live_plus_backfilled, 1);
  assert.equal(r.backfilled.stage_totals.bought, 1);
  assert.ok(SNAPSHOT_STAGES.every((s) => s in r.backfilled.stage_totals));
  assert.match(formatCompleteness(r), /BACKFILLED \(provenance=backfilled/);
}

// 7. settingsLedger attributes unhashed trades to the backfilled hash of their entry cycle.
{
  const closed = [
    { position_id: "p1", symbol: "CCC", contract_address: A(3), entry_ms: Date.parse("2026-04-01T00:03:00Z"), entry_cycle_id: c1, entry_settings_hash: null, pnl_usd: 10, net_return: 0.05, cost_usd: 200 },
    { position_id: "p2", symbol: "EEE", contract_address: A(6), entry_ms: Date.parse("2026-04-05T00:00:00Z"), entry_cycle_id: "unknown-cycle", entry_settings_hash: null, pnl_usd: -5, net_return: -0.02, cost_usd: 250 }
  ];
  const r = buildSettingsLedgerReport({ settingsLedgerRecords: ledgerRecords, snapshotRecords, closedPositions: closed });
  assert.equal(r.trades_attributed_via_backfilled_cycle, 1);
  const v1 = r.versions.find((v) => v.settings_hash === cyc1.settings_hash);
  assert.equal(v1.provenance, "backfilled");
  assert.equal(v1.closed_trades, 1);
  assert.equal(r.versions.find((v) => v.settings_hash === "unhashed").closed_trades, 1);
  const v2 = r.versions.find((v) => v.settings_hash === cyc2.settings_hash);
  assert.deepEqual(v2.changed_from_previous, [{ key: "default_stop_distance_pct", from: null, to: 0.25 }]);
  assert.match(formatSettingsLedger(r), /\[backfilled\]/);
  const plain = buildSettingsLedgerReport({ closedPositions: closed });
  assert.equal(plain.trades_attributed_via_backfilled_cycle, 0, "without backfilled data nothing is attributed");
}

console.log("verifyBackfillSnapshots: all checks passed");
