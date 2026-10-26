// Point-in-time candidate snapshots: one JSONL record per candidate per cycle,
// plus one "cycle" record and bounded "price_marks" records, written to
// logs/candidate-snapshots.jsonl (gitignored via logs/*). Settings versions go to
// logs/settings-ledger.jsonl.
//
// Purpose: make the scout/gate decisions replayable. The record holds what the
// gate could observe at decision time (price, liquidity, mcap, volume, slippage,
// fraud, confidence, evidence count, regime) and how far each candidate got.
//
// Safety contract (tested in scripts/verifyCandidateSnapshots.js):
//  - Every exported function catches its own errors and never throws.
//  - Inputs are only read, never mutated (no assignment into candidate objects).
//  - No wallet, custody, cash, quantity, cost basis or PnL fields are written.
//  - Each record is capped at MAX_RECORD_BYTES; a record that cannot be shrunk is dropped.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSettingsLedgerRecord, computeSettingsHashSafe } from "./settingsHash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SNAPSHOT_FILE = path.join(__dirname, "..", "logs", "candidate-snapshots.jsonl");
export const DEFAULT_SETTINGS_LEDGER_FILE = path.join(__dirname, "..", "logs", "settings-ledger.jsonl");
export const CANDIDATE_SNAPSHOT_SCHEMA_VERSION = "candidate-snapshot-v1";
export const MAX_RECORD_BYTES = 8192;
export const MAX_CANDIDATES_PER_CYCLE = 400;
export const MAX_PRICE_MARKS_PER_CYCLE = 500;
export const PRICE_MARKS_PER_RECORD = 100;
export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

// Ordered from earliest to furthest; a candidate's stage is the furthest it reached.
export const SNAPSHOT_STAGES = [
  "universe_blocked",   // packet built, blocked by evidence eligibility before the scout LLM
  "ranked_out",         // eligible but below the evidence shortlist limit
  "shortlisted",        // in the evidence shortlist given to scout, not proposed
  "desk_filtered",      // proposed by scout, dropped by the portfolio/desk filter
  "price_rejected",     // dropped by cross-source price validation
  "gate_rejected",      // rejected by deterministicBuyGate (reason_codes = blockers)
  "risk_vetoed",        // passed the gate, rejected by the risk reviewer
  "approved",           // approved for the executor
  "bought"              // a buy (or rotation buy) trade was filled this cycle
];
const STAGE_RANK = new Map(SNAPSHOT_STAGES.map((stage, index) => [stage, index]));

let lastLedgerHash = null;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNum(...values) {
  for (const value of values) {
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}

function str(value, max = 64) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function addr(value) {
  const s = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? s : (s ? s.slice(0, 64) : null);
}

function safeList(value) {
  try {
    return Array.isArray(value) ? value.slice(0, 5000) : [];
  } catch {
    return [];
  }
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function reasonCodes(values, max = 8) {
  return safeList(values).map((value) => str(value, 64)).filter(Boolean).slice(0, max);
}

// Shallow copy of an array of candidate references, taken at a point in the cycle.
// Never throws; returns [] for anything that is not an array.
export function captureCandidateList(value) {
  return safeList(value);
}

// Observable fields, read with the same field precedence deterministicBuyGate uses.
export function extractObservables(candidate, gateMetrics = null) {
  return safe(() => {
    const c = candidate || {};
    const g = gateMetrics || {};
    const dq = c.market_data_quality?.normalized || {};
    return {
      token_address: addr(c.token?.contract_address ?? c.contract_address ?? c.address),
      symbol: str(c.token?.symbol ?? c.symbol, 32),
      price_usd: firstNum(g.price, dq.price_usd, c.market_data?.current_price, c.price_usd),
      liquidity_usd: firstNum(g.liquidity_usd, dq.liquidity_usd, c.liquidity_data?.liquidity_usd, c.liquidity_usd),
      market_cap_usd: firstNum(g.market_cap_usd, c.market_data?.market_cap_usd, c.market_cap_usd),
      volume_24h_usd: firstNum(g.volume_24h_usd, c.market_data?.volume_24h_usd, c.volume_24h_usd),
      change_24h_pct: firstNum(c.market_data?.change_24h_pct, c.change_24h),
      slippage_bps: firstNum(g.slippage_bps, dq.slippage_bps, c.execution_data?.estimated_slippage_bps),
      fraud_risk: firstNum(g.fraud_risk, c.fraud_risk),
      fragility_score: firstNum(g.fragility_score, c._fragility_score),
      confidence: firstNum(g.confidence, c.confidence),
      evidence_count: firstNum(g.evidence_count, Array.isArray(c.evidence) ? c.evidence.length : null),
      setup_type: str(c.setup_type ?? c.source, 48)
    };
  }, {});
}

// Summarise the scout's evidence shortlist build (all packets: blocked, ranked out,
// shortlisted) and the raw token universe prices. Called inside runScoutDirect.
export function captureScoutUniverse(shortlistBuild, tokenUniverse) {
  return safe(() => {
    const blocked = new Map();
    for (const item of safeList(shortlistBuild?.blocked)) {
      const a = addr(item?.contract_address);
      if (a) blocked.set(a, reasonCodes([...safeList(item?.hard_blockers), ...safeList(item?.reasons)]));
    }
    const shortlisted = new Set(safeList(shortlistBuild?.shortlist).map((entry) => addr(entry?.address)).filter(Boolean));
    const entries = [];
    for (const entry of safeList(shortlistBuild?.entries).slice(0, MAX_CANDIDATES_PER_CYCLE)) {
      const a = addr(entry?.address);
      if (!a) continue;
      const input = entry?.scout_input || {};
      const obs = extractObservables({ ...input, token: { ...(input.token || {}), contract_address: a, symbol: entry?.symbol ?? input.token?.symbol } });
      obs.evidence_count = firstNum(entry?.packet_summary?.evidence_count, entry?.packet?.evidence_count, obs.evidence_count);
      const stage = shortlisted.has(a) ? "shortlisted" : blocked.has(a) ? "universe_blocked" : "ranked_out";
      entries.push({ ...obs, stage, reason_codes: stage === "universe_blocked" ? blocked.get(a) : [], rank_score: num(entry?.ranking?.score) });
    }
    const marks = [];
    const seen = new Set();
    for (const token of safeList(tokenUniverse)) {
      if (marks.length >= MAX_PRICE_MARKS_PER_CYCLE) break;
      const a = addr(token?.address ?? token?.contract_address);
      const price = num(token?.price_usd);
      if (!a || !/^0x[0-9a-f]{40}$/.test(a) || seen.has(a) || !(price > 0)) continue;
      seen.add(a);
      marks.push([a, price, num(token?.liquidity_usd)]);
    }
    return { entries, marks };
  }, null);
}

function setStage(byAddr, key, stage, data) {
  const existing = byAddr.get(key);
  if (!existing || STAGE_RANK.get(stage) >= STAGE_RANK.get(existing.stage)) {
    // Keep earlier observables when the later stage has none for a field.
    const merged = { ...(existing || {}) };
    for (const [field, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) merged[field] = value;
    }
    merged.stage = stage;
    byAddr.set(key, merged);
  }
}

function keyFor(obs) {
  return obs.token_address || (obs.symbol ? `sym:${String(obs.symbol).toLowerCase()}` : null);
}

// Build (but do not write) the records for one cycle.
export function buildCycleSnapshotRecords(input = {}) {
  return safe(() => {
    const ts = str(input.ts, 40) || new Date().toISOString();
    const base = {
      schema_version: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
      ts,
      cycle_id: str(input.cycleId, 64),
      pipeline_run_id: str(input.pipelineRunId, 64),
      cycle_index: num(input.cycleIndex),
      regime: str(input.regime, 32),
      settings_hash: str(input.settingsHash, 40)
    };
    const byAddr = new Map();
    for (const entry of safeList(input.universe?.entries)) {
      const key = keyFor(entry);
      if (key) setStage(byAddr, key, entry.stage, entry);
    }
    const listStages = [
      ["desk_filtered", input.proposed],
      // Every desk-kept candidate starts as price_rejected; the ones that survived price
      // validation all reach runRiskForCandidates and are promoted below from
      // rejected/approved, so only the ones validation dropped keep this stage.
      ["price_rejected", input.deskKept]
    ];
    for (const [stage, list] of listStages) {
      for (const candidate of safeList(list)) {
        const obs = extractObservables(candidate);
        const key = keyFor(obs);
        if (key) setStage(byAddr, key, stage, { ...obs, reason_codes: [stage === "desk_filtered" ? "desk_or_portfolio_filter" : "price_validation_failed"] });
      }
    }
    for (const entry of safeList(input.rejected)) {
      const risk = entry?.risk || {};
      const obs = extractObservables(entry?.proposal, risk.gate_metrics);
      const key = keyFor(obs);
      if (!key) continue;
      const stage = risk.deterministic_gate ? "gate_rejected" : "risk_vetoed";
      setStage(byAddr, key, stage, { ...obs, reason_codes: reasonCodes(risk.reason_codes || risk.blocker_list) });
    }
    for (const candidate of safeList(input.approved)) {
      const obs = extractObservables(candidate);
      const key = keyFor(obs);
      if (key) setStage(byAddr, key, "approved", { ...obs, reason_codes: reasonCodes(candidate?._risk?.reason_codes) });
    }
    const boughtKeys = new Set();
    for (const trade of [...safeList(input.buyTrades), ...safeList(input.rotationResults).map((r) => r?.result?.buyTrade)]) {
      if (!trade || String(trade.side || "buy") !== "buy") continue;
      const a = addr(trade.contract_address);
      if (a) boughtKeys.add(a);
      const s = str(trade.symbol, 32);
      if (s) boughtKeys.add(`sym:${s.toLowerCase()}`);
    }
    for (const [key, value] of byAddr) {
      if (boughtKeys.has(key) || (value.symbol && boughtKeys.has(`sym:${String(value.symbol).toLowerCase()}`))) {
        if (STAGE_RANK.get(value.stage) >= STAGE_RANK.get("approved")) value.stage = "bought";
      }
    }

    const records = [];
    const stageCounts = Object.fromEntries(SNAPSHOT_STAGES.map((stage) => [stage, 0]));
    let candidateCount = 0;
    for (const value of byAddr.values()) {
      if (candidateCount >= MAX_CANDIDATES_PER_CYCLE) break;
      candidateCount += 1;
      stageCounts[value.stage] = (stageCounts[value.stage] || 0) + 1;
      records.push({
        ...base,
        record_type: "candidate",
        token_address: value.token_address ?? null,
        symbol: value.symbol ?? null,
        stage: value.stage,
        reason_codes: reasonCodes(value.reason_codes),
        price_usd: value.price_usd ?? null,
        liquidity_usd: value.liquidity_usd ?? null,
        market_cap_usd: value.market_cap_usd ?? null,
        volume_24h_usd: value.volume_24h_usd ?? null,
        change_24h_pct: value.change_24h_pct ?? null,
        slippage_bps: value.slippage_bps ?? null,
        fraud_risk: value.fraud_risk ?? null,
        fragility_score: value.fragility_score ?? null,
        confidence: value.confidence ?? null,
        evidence_count: value.evidence_count ?? null,
        setup_type: value.setup_type ?? null,
        rank_score: value.rank_score ?? null
      });
    }
    const marks = safeList(input.universe?.marks).slice(0, MAX_PRICE_MARKS_PER_CYCLE);
    for (let i = 0; i < marks.length; i += PRICE_MARKS_PER_RECORD) {
      records.push({ ...base, record_type: "price_marks", marks: marks.slice(i, i + PRICE_MARKS_PER_RECORD) });
    }
    records.unshift({
      ...base,
      record_type: "cycle",
      eth_price_usd: num(input.ethPriceUsd),
      candidate_count: candidateCount,
      stage_counts: stageCounts,
      universe_captured: Boolean(input.universe),
      price_mark_count: marks.length
    });
    return records;
  }, []);
}

function boundRecord(record) {
  let line = JSON.stringify(record);
  if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line;
  const trimmed = { ...record, reason_codes: (record.reason_codes || []).slice(0, 2), setup_type: null };
  if (Array.isArray(record.marks)) trimmed.marks = record.marks.slice(0, 20);
  line = JSON.stringify(trimmed);
  return Buffer.byteLength(line) <= MAX_RECORD_BYTES ? line : null;
}

function defaultWriter(filePath) {
  return (lines) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines.join("\n") + "\n");
  };
}

// Build and append one cycle's records. Never throws. Returns a small status object.
// options.writer(lines[]) and options.ledgerWriter(lines[]) can be injected (tests).
export function writeCycleCandidateSnapshots(input = {}, options = {}) {
  const status = { ok: false, written: 0, dropped: 0, error: null };
  try {
    const records = buildCycleSnapshotRecords(input);
    // A successful build always yields at least the "cycle" record.
    if (!records.length) throw new Error("snapshot_build_failed");
    const lines = [];
    for (const record of records) {
      const line = boundRecord(record);
      if (line) lines.push(line);
      else status.dropped += 1;
    }
    const writer = options.writer || defaultWriter(options.filePath || DEFAULT_SNAPSHOT_FILE);
    if (lines.length) writer(lines);
    status.written = lines.length;
    status.ok = true;
  } catch (error) {
    status.error = safe(() => String(error?.message || error).slice(0, 200), "unknown_error");
  }
  try {
    if (input.settings && input.settingsHash && input.settingsHash !== lastLedgerHash) {
      const ledgerWriter = options.ledgerWriter || defaultWriter(options.ledgerFilePath || DEFAULT_SETTINGS_LEDGER_FILE);
      const record = buildSettingsLedgerRecord(input.settings, str(input.ts, 40) || new Date().toISOString());
      const line = JSON.stringify({ ...record, cycle_id: str(input.cycleId, 64) });
      if (Buffer.byteLength(line) <= 4 * MAX_RECORD_BYTES) {
        ledgerWriter([line]);
        lastLedgerHash = input.settingsHash;
      }
    }
  } catch (error) {
    if (!status.error) status.error = safe(() => `ledger: ${String(error?.message || error).slice(0, 200)}`, "ledger_error");
  }
  return status;
}

// Convenience for pipeline.js: hash + write in one never-throwing call.
export function recordCycleCandidateSnapshots(input = {}, options = {}) {
  try {
    const settingsHash = input.settingsHash ?? computeSettingsHashSafe(input.settings);
    return writeCycleCandidateSnapshots({ ...input, settingsHash }, options);
  } catch (error) {
    return { ok: false, written: 0, dropped: 0, error: safe(() => String(error?.message || error).slice(0, 200), "unknown_error") };
  }
}

export function resetSnapshotLedgerMemoForTests() {
  lastLedgerHash = null;
}
