// Offline checks for the point-in-time candidate snapshot logger
// (scripts/candidateSnapshots.js) and its hook in pipeline.js.
import assert from "assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// pipeline.js log()/training events append to logs/; keep this check side-effect free.
const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = () => {};

const snap = await import("./candidateSnapshots.js");
const { computeSettingsHash } = await import("./settingsHash.js");
const pipeline = await import("../pipeline.js");
fs.appendFileSync = originalAppendFileSync;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
const hashOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function candidate(n, extra = {}) {
  return {
    token: { symbol: `T${n}`, contract_address: A(n), category: "defi" },
    market_data: { current_price: n, market_cap_usd: 5e7, volume_24h_usd: 2e6, change_24h_pct: 3 },
    liquidity_data: { liquidity_usd: 2e6 },
    execution_data: { estimated_slippage_bps: 40 },
    fraud_risk: 10,
    confidence: 72,
    evidence: [{ id: 1 }, { id: 2 }, { id: 3 }],
    setup_type: "thesis",
    ...extra
  };
}

function buildInput() {
  const c1 = candidate(1); // universe_blocked only
  const c2 = candidate(2); // desk filtered
  const c3 = candidate(3); // price rejected
  const c4 = candidate(4); // gate rejected
  const c5 = candidate(5); // risk vetoed
  const c6 = candidate(6); // approved, not bought
  const c7 = candidate(7); // bought
  const settings = { ...pipeline.SETTINGS_DEFAULTS };
  return {
    ts: "2026-10-01T00:00:00.000Z",
    cycleId: "cycle-1",
    pipelineRunId: "run-1",
    cycleIndex: 3,
    regime: "neutral",
    settings,
    settingsHash: computeSettingsHash(settings),
    ethPriceUsd: 3100,
    universe: snap.captureScoutUniverse({
      entries: [1, 2, 3, 8].map((n) => ({ address: A(n), symbol: `T${n}`, scout_input: candidate(n), packet_summary: { evidence_count: 4 }, ranking: { score: n } })),
      shortlist: [{ address: A(2) }, { address: A(3) }],
      blocked: [{ contract_address: A(1), reasons: ["low_quality"], hard_blockers: ["no_evidence"] }]
    }, [{ address: A(1), price_usd: 1, liquidity_usd: 5 }, { address: A(9), price_usd: 9 }, { address: "bad", price_usd: 1 }]),
    proposed: [c2, c3, c4, c5, c6, c7],
    deskKept: [c3, c4, c5, c6, c7],
    rejected: [
      { proposal: c4, risk: { decision: "reject", deterministic_gate: true, reason_codes: ["liquidity_below_100k", "fraud_risk_high"], gate_metrics: { price: 4.5, liquidity_usd: 50000, market_cap_usd: 1e6, volume_24h_usd: 5000, slippage_bps: 120, fraud_risk: 40, confidence: 50, evidence_count: 1 } } },
      { proposal: c5, risk: { decision: "reject", reason_codes: ["confidence_too_low"] } }
    ],
    approved: [{ ...c6, _risk: { reason_codes: ["price_ok"] } }, { ...c7, _risk: { reason_codes: ["price_ok"] } }],
    buyTrades: [{ side: "buy", symbol: "T7", contract_address: A(7), quantity: 10, cost_usd: 1000 }],
    rotationResults: []
  };
}

const EXPECTED_CANDIDATE_KEYS = [
  "schema_version", "ts", "cycle_id", "pipeline_run_id", "cycle_index", "regime", "settings_hash", "record_type",
  "token_address", "symbol", "stage", "reason_codes", "price_usd", "liquidity_usd", "market_cap_usd", "volume_24h_usd",
  "change_24h_pct", "slippage_bps", "fraud_risk", "fragility_score", "confidence", "evidence_count", "setup_type", "rank_score"
].sort();
const FORBIDDEN_KEY = /(quantity|cost|cash|pnl|wallet|private|secret|mnemonic|tx_hash|equity|proceeds)/i;

// 1. Schema and stage resolution.
{
  const input = buildInput();
  const records = snap.buildCycleSnapshotRecords(input);
  assert.equal(records[0].record_type, "cycle");
  assert.equal(records[0].eth_price_usd, 3100);
  assert.equal(records[0].settings_hash, input.settingsHash);
  assert.match(records[0].settings_hash, /^sh1:[0-9a-f]{16}$/);
  const candidates = records.filter((r) => r.record_type === "candidate");
  const byAddr = Object.fromEntries(candidates.map((r) => [r.token_address, r]));
  assert.equal(byAddr[A(1)].stage, "universe_blocked");
  assert.deepEqual(byAddr[A(1)].reason_codes, ["no_evidence", "low_quality"]);
  assert.equal(byAddr[A(8)].stage, "ranked_out");
  assert.equal(byAddr[A(2)].stage, "desk_filtered");
  assert.equal(byAddr[A(3)].stage, "price_rejected");
  assert.equal(byAddr[A(4)].stage, "gate_rejected");
  assert.deepEqual(byAddr[A(4)].reason_codes, ["liquidity_below_100k", "fraud_risk_high"]);
  assert.equal(byAddr[A(4)].liquidity_usd, 50000, "gate-rejected records carry the gate's own metrics");
  assert.equal(byAddr[A(4)].fraud_risk, 40);
  assert.equal(byAddr[A(5)].stage, "risk_vetoed");
  assert.equal(byAddr[A(6)].stage, "approved");
  assert.equal(byAddr[A(7)].stage, "bought");
  assert.equal(candidates.length, 8);
  for (const r of candidates) {
    assert.deepEqual(Object.keys(r).sort(), EXPECTED_CANDIDATE_KEYS);
    assert.ok(snap.SNAPSHOT_STAGES.includes(r.stage));
    assert.equal(r.schema_version, snap.CANDIDATE_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(r.cycle_id, "cycle-1");
    assert.equal(r.settings_hash, input.settingsHash);
    for (const field of ["price_usd", "liquidity_usd", "market_cap_usd", "volume_24h_usd", "slippage_bps", "fraud_risk", "confidence", "evidence_count"]) {
      assert.ok(r[field] === null || Number.isFinite(r[field]), `${field} is a number or null`);
    }
  }
  assert.equal(byAddr[A(6)].price_usd, 6);
  assert.equal(byAddr[A(6)].slippage_bps, 40);
  assert.equal(byAddr[A(6)].evidence_count, 3);
  assert.equal(byAddr[A(6)].regime, "neutral");
  const marks = records.filter((r) => r.record_type === "price_marks");
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].marks, [[A(1), 1, 5], [A(9), 9, null]], "price marks keep valid addresses only");
  for (const r of records) {
    for (const key of Object.keys(r)) assert.ok(!FORBIDDEN_KEY.test(key), `no account/wallet field in snapshot: ${key}`);
  }
}

// 2. Writer: lines round-trip, bounded size, settings ledger written once per hash.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-"));
  const filePath = path.join(dir, "candidate-snapshots.jsonl");
  const ledgerFilePath = path.join(dir, "settings-ledger.jsonl");
  snap.resetSnapshotLedgerMemoForTests();
  const status = snap.recordCycleCandidateSnapshots(buildInput(), { filePath, ledgerFilePath });
  assert.equal(status.ok, true, status.error);
  const status2 = snap.recordCycleCandidateSnapshots({ ...buildInput(), cycleId: "cycle-2" }, { filePath, ledgerFilePath });
  assert.equal(status2.ok, true);
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, status.written + status2.written);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) <= snap.MAX_RECORD_BYTES);
    JSON.parse(line);
  }
  const ledger = fs.readFileSync(ledgerFilePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1, "settings ledger only records a new hash once");
  assert.equal(ledger[0].settings_hash, buildInput().settingsHash);
  fs.rmSync(dir, { recursive: true, force: true });

  // Oversized inputs stay bounded.
  const huge = buildInput();
  huge.rejected = [{ proposal: candidate(4, { setup_type: "x".repeat(100000) }), risk: { deterministic_gate: true, reason_codes: Array.from({ length: 500 }, (_, i) => `code_${i}_${"y".repeat(500)}`) } }];
  huge.proposed = Array.from({ length: 2000 }, (_, i) => candidate(i + 10, { token: { symbol: `S${i}`, contract_address: `0x${(i + 10).toString(16).padStart(40, "0")}` } }));
  huge.universe = snap.captureScoutUniverse({ entries: [] }, Array.from({ length: 5000 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, "0")}`, price_usd: 1 })));
  const out = [];
  const st = snap.writeCycleCandidateSnapshots(huge, { writer: (l) => out.push(...l), ledgerWriter: () => {} });
  assert.equal(st.ok, true);
  const parsed = out.map((l) => JSON.parse(l));
  assert.ok(parsed.filter((r) => r.record_type === "candidate").length <= snap.MAX_CANDIDATES_PER_CYCLE);
  assert.ok(parsed.filter((r) => r.record_type === "price_marks").reduce((s, r) => s + r.marks.length, 0) <= snap.MAX_PRICE_MARKS_PER_CYCLE);
  for (const l of out) assert.ok(Buffer.byteLength(l) <= snap.MAX_RECORD_BYTES);
  for (const r of parsed.filter((x) => x.record_type === "candidate")) assert.ok(r.reason_codes.length <= 8 && r.reason_codes.every((c) => c.length <= 64));
}

// 3. Failure safety: failing writers, hostile and frozen inputs never throw and never mutate.
{
  const failing = () => { throw new Error("disk full"); };
  snap.resetSnapshotLedgerMemoForTests();
  const status = snap.recordCycleCandidateSnapshots(buildInput(), { writer: failing, ledgerWriter: failing });
  assert.equal(status.ok, false);
  assert.match(status.error, /disk full/);

  const hostile = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
  const hostileArray = new Proxy([candidate(1)], { get(target, prop) { if (prop === "slice") throw new Error("boom"); return target[prop]; } });
  const circular = candidate(5);
  circular.self = circular;
  const weird = [hostile, null, undefined, 42, "str", circular, { token: { contract_address: 10n } }];
  const cases = [
    undefined, null, hostile,
    { ...buildInput(), proposed: hostile, deskKept: hostileArray, rejected: weird, approved: weird, buyTrades: weird, rotationResults: weird, universe: hostile, settings: hostile },
    { ...buildInput(), settings: circular, settingsHash: undefined }
  ];
  for (const input of cases) {
    let result;
    assert.doesNotThrow(() => { result = snap.recordCycleCandidateSnapshots(input, { writer: failing, ledgerWriter: failing }); });
    assert.equal(typeof result, "object");
    assert.doesNotThrow(() => snap.recordCycleCandidateSnapshots(input, { writer: () => {}, ledgerWriter: () => {} }));
    assert.doesNotThrow(() => snap.buildCycleSnapshotRecords(input));
  }
  assert.doesNotThrow(() => snap.captureScoutUniverse(hostile, hostile));
  assert.equal(snap.captureScoutUniverse(hostile, hostile)?.entries?.length ?? 0, 0);
  assert.deepEqual(snap.captureCandidateList(hostile), []);
  assert.deepEqual(snap.captureCandidateList(hostileArray), []);

  // Deep-frozen inputs: any write attempt would throw in strict mode and turn ok into false.
  const frozen = buildInput();
  const before = hashOf({ ...frozen, settings: frozen.settings });
  deepFreeze(frozen);
  snap.resetSnapshotLedgerMemoForTests();
  const st = snap.recordCycleCandidateSnapshots(frozen, { writer: () => {}, ledgerWriter: () => {} });
  assert.equal(st.ok, true, st.error);
  assert.equal(hashOf({ ...frozen, settings: frozen.settings }), before, "inputs are not mutated");
}

// 4. A failing snapshot writer cannot change a cycle's decisions: run the deterministic
// scout filters with and without a (failing) snapshot call in between; outputs and
// inputs must be identical.
{
  fs.appendFileSync = () => {};
  try {
    const portfolio = { positions: {}, cooldowns: {}, settings: { ...pipeline.SETTINGS_DEFAULTS }, stats: {} };
    const makeCandidates = () => [candidate(1), candidate(2, { liquidity_data: { liquidity_usd: 5000 } }), candidate(3, { market_data: { current_price: 3, change_24h_pct: 40 } })];
    const runCycleSlice = (withSnapshot) => {
      const candidates = makeCandidates();
      const proposed = snap.captureCandidateList(candidates);
      const kept = pipeline.filterScoutCandidatesForDesk(pipeline.filterScoutCandidatesAgainstPortfolio(candidates, portfolio), portfolio)
        .map((c) => pipeline.hydrateCandidateTradingMetrics(c, portfolio));
      const deskKept = snap.captureCandidateList(kept);
      const before = hashOf(kept);
      if (withSnapshot) {
        const status = snap.recordCycleCandidateSnapshots({ cycleId: "c", settings: portfolio.settings, proposed, deskKept, approved: kept }, {
          writer: () => { throw new Error("fail"); }, ledgerWriter: () => { throw new Error("fail"); }
        });
        assert.equal(status.ok, false);
      }
      assert.equal(hashOf(kept), before);
      return { kept: hashOf(kept), ranked: hashOf(pipeline.rankApprovedCandidates(kept.map((c) => ({ ...c, _score: 50 })), portfolio)), portfolio: hashOf(portfolio) };
    };
    assert.deepEqual(runCycleSlice(true), runCycleSlice(false));
  } finally {
    fs.appendFileSync = originalAppendFileSync;
  }
}

// 5. Static wiring check on pipeline.js: one guarded hook after decisions are final,
// read-only captures, and the result is only logged.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "pipeline.js"), "utf8");
  const calls = src.match(/recordCycleCandidateSnapshots\(/g) || [];
  assert.equal(calls.length, 1, "exactly one snapshot hook in pipeline.js");
  const hookIdx = src.indexOf("recordCycleCandidateSnapshots(");
  const preceding = src.slice(Math.max(0, hookIdx - 400), hookIdx);
  assert.match(preceding, /try \{\s*const snapshotStatus = $/, "hook is inside its own try block");
  const after = src.slice(hookIdx, hookIdx + 2000);
  assert.match(after, /catch \(snapshotErr\)/);
  assert.ok(hookIdx > src.indexOf('recordCycleEvent("cycle_end"'), "hook runs after the cycle_end event (all trades done)");
  assert.ok(hookIdx > src.indexOf("savePortfolio(portfolio);\n\n    const summary"), "hook runs after the portfolio is saved");
  assert.equal((src.match(/snapshotStatus/g) || []).length, 3, "snapshot status is only checked and logged");
  assert.equal((src.match(/captureScoutUniverse\(/g) || []).length, 1);
  assert.equal((src.match(/_cycleSnapshotUniverse/g) || []).length, 4, "universe capture is only declared, reset, set and passed to the hook");
  assert.equal((src.match(/snapshotProposedCandidates/g) || []).length, 2);
  assert.equal((src.match(/snapshotDeskKeptCandidates/g) || []).length, 2);
}

console.log("verifyCandidateSnapshots: ok");
