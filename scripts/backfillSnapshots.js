#!/usr/bin/env node
// Backfill point-in-time candidate snapshots from historical training events.
//
// scripts/candidateSnapshots.js only records cycles from the day its hook was deployed.
// This script rebuilds the same snapshot JSONL format (candidate-snapshot-v1) for
// earlier cycles from logs/training-events.jsonl, so the evaluation tools can run on
// history. Every record it writes carries provenance: "backfilled".
//
// What it uses (all recorded at decision time by pipeline.js, nothing recomputed):
//   cycle_start    -> cycle record (time, regime) and the portfolio settings overrides
//                     logged with it (backfilled settings hash "bf1:...", see below);
//                     held-position and market-trend prices -> price_marks
//   candidate      -> desk-kept scout candidates (price, liquidity, mcap, volume, slippage, fraud)
//   risk_decision  -> buy proposals: gate_rejected / risk_vetoed / approved, with the
//                     proposal's confidence, evidence count and fragility score
//   trade (buy)    -> bought
//   cycle_end      -> a second price_marks record at the cycle's end time
//
// What it does NOT do (never invent):
//   - Fields not present in the history stay null. There is no scout universe
//     (universe_blocked / ranked_out / shortlisted) and no desk_filtered stage, because
//     training events do not hold them; universe_captured is false.
//   - A desk-kept candidate with no buy risk_decision in the same cycle gets stage
//     "price_rejected" (the stage the live hook gives candidates that never reached the
//     gate) with reason code "backfill_no_risk_decision": history does not say why.
//   - Trade fill prices are not used as price marks (they include simulated slippage).
//   - ETH price: only from a WETH price mark in the same cycle, else null.
//   - Settings: cycle_start logs portfolio.settings (the overrides), not the effective
//     SETTINGS_DEFAULTS merge. The backfilled hash is "bf1:" + a hash of those overrides
//     and is written to a separate backfilled settings ledger with
//     settings_scope "portfolio_overrides_only". It never equals a live "sh1:" hash.
//   - Records hold no wallet, cash, quantity, cost basis or PnL fields.
//
// Usage:
//   node scripts/backfillSnapshots.js [--input=logs/training-events.jsonl]
//        [--out=logs/candidate-snapshots.backfilled.jsonl]
//        [--ledger-out=logs/settings-ledger.backfilled.jsonl]
//        [--from=ISO] [--to=ISO] [--force]
// The outputs are new files; the input is only read (streamed). An existing output is
// not overwritten without --force, and an output path equal to the input is refused.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { MAX_PRICE_MARKS_PER_CYCLE, PRICE_MARKS_PER_RECORD, buildCycleSnapshotRecords } from "./candidateSnapshots.js";
import { DEFAULT_FILES, ROOT, WETH_ADDRESS, parseArgs, toMs } from "./evalData.js";
import { redactSettingsForLedger, stableStringify } from "./settingsHash.js";

export const BACKFILL_PROVENANCE = "backfilled";
export const BACKFILL_HASH_PREFIX = "bf1";
export const DEFAULT_BACKFILL_FILES = {
  snapshots: path.join(ROOT, "logs", "candidate-snapshots.backfilled.jsonl"),
  settingsLedger: path.join(ROOT, "logs", "settings-ledger.backfilled.jsonl")
};
const STALE_CYCLE_MS = 6 * 3600 * 1000;
const RELEVANT_EVENTS = ["cycle_start", "cycle_end", "candidate", "risk_decision", "trade"];

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addr(value) {
  const s = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? s : null;
}

export function backfilledSettingsHash(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const digest = crypto.createHash("sha256").update(stableStringify(settings)).digest("hex");
  return `${BACKFILL_HASH_PREFIX}:${digest.slice(0, 16)}`;
}

function isBuyProposal(proposal) {
  const action = String(proposal?.action || "").toLowerCase();
  return !/(exit|sell|trim|monitor|hold)/.test(action);
}

// Price marks from a cycle_start/cycle_end payload: held positions and the market-trend
// gainer/loser lists the pipeline attached to them. Address, price and liquidity only.
export function extractMarks(payload) {
  const marks = new Map();
  const add = (address, price, liquidity) => {
    const a = addr(address);
    const p = num(price);
    if (!a || !(p > 0) || marks.has(a)) return;
    marks.set(a, [a, p, num(liquidity)]);
  };
  const holdings = Array.isArray(payload?.portfolio_intelligence?.holdings) ? payload.portfolio_intelligence.holdings : [];
  for (const h of holdings) {
    add(h?.token?.contract_address ?? h?.position?.contract_address ?? h?.contract_address,
      h?.market_data?.current_price ?? h?.position?.current_price ?? h?.current_price,
      h?.liquidity_data?.liquidity_usd ?? h?.market_data?.liquidity_usd ?? h?.position?.liquidity_usd);
  }
  for (const h of holdings) {
    for (const t of [...(h?.market_trends?.gainers || []), ...(h?.market_trends?.losers || [])]) {
      add(t?.contract_address ?? t?.address, t?.current_price ?? t?.price_usd, t?.liquidity_usd);
    }
  }
  return [...marks.values()].slice(0, MAX_PRICE_MARKS_PER_CYCLE);
}

function newCycle(event) {
  return {
    cycle_id: event.cycle_id,
    pipeline_run_id: event.pipeline_run_id || null,
    cycle_index: num(event.cycle_index),
    ts: null,
    first_ms: null,
    last_ms: null,
    regime: event.market_regime || null,
    settings: null,
    startMarks: [],
    end: null,
    candidates: [],
    rejected: [],
    approved: [],
    buyTrades: []
  };
}

// Feed one training event into the per-cycle state. Returns false when ignored.
export function addEventToCycle(cycles, event) {
  if (!event || !RELEVANT_EVENTS.includes(event.event_type) || !event.cycle_id) return false;
  const ms = toMs(event.ts);
  if (ms == null) return false;
  if (!cycles.has(event.cycle_id)) cycles.set(event.cycle_id, newCycle(event));
  const c = cycles.get(event.cycle_id);
  c.first_ms = c.first_ms == null ? ms : Math.min(c.first_ms, ms);
  c.last_ms = c.last_ms == null ? ms : Math.max(c.last_ms, ms);
  if (!c.regime && event.market_regime) c.regime = event.market_regime;
  const p = event.payload || {};
  switch (event.event_type) {
    case "cycle_start":
      c.ts = new Date(ms).toISOString();
      if (p.settings && typeof p.settings === "object") c.settings = p.settings;
      c.startMarks = extractMarks(p);
      break;
    case "cycle_end":
      c.end = { ts: new Date(ms).toISOString(), marks: extractMarks(p) };
      break;
    case "candidate":
      c.candidates.push({ token: p.token, market_data: p.market_data, liquidity_data: p.liquidity_data, execution_data: p.execution_data, fraud_risk: p.fraud_risk });
      break;
    case "risk_decision": {
      const proposal = p.proposal;
      if (!proposal || !isBuyProposal(proposal)) return false;
      const risk = p.risk_review || {};
      const decision = String(p.decision ?? risk.decision ?? "").toLowerCase();
      const approved = p.handoff_to_executor === true || decision === "approve_for_executor" || decision === "paper_trade";
      if (approved) c.approved.push({ ...proposal, _risk: risk });
      else c.rejected.push({ proposal, risk });
      break;
    }
    case "trade": {
      const t = p.trade || {};
      if (String(t.side || "") === "buy") c.buyTrades.push({ side: "buy", contract_address: t.contract_address, symbol: t.symbol });
      break;
    }
    default:
      return false;
  }
  return true;
}

// Build the backfilled snapshot records for one finished cycle.
export function buildBackfilledCycleRecords(c) {
  const ts = c.ts || new Date(c.first_ms).toISOString();
  const settingsHash = backfilledSettingsHash(c.settings);
  const eth = c.startMarks.find((m) => m[0] === WETH_ADDRESS);
  const records = buildCycleSnapshotRecords({
    ts,
    cycleId: c.cycle_id,
    pipelineRunId: c.pipeline_run_id,
    cycleIndex: c.cycle_index,
    regime: c.regime,
    settingsHash,
    ethPriceUsd: eth ? eth[1] : null,
    universe: { entries: [], marks: c.startMarks },
    proposed: [],
    deskKept: c.candidates,
    rejected: c.rejected,
    approved: c.approved,
    buyTrades: c.buyTrades
  });
  const out = [];
  for (const r of records) {
    const rec = { ...r, provenance: BACKFILL_PROVENANCE };
    if (rec.record_type === "cycle") {
      rec.universe_captured = false;
      rec.backfill_source = "training-events";
      rec.settings_scope = c.settings ? "portfolio_overrides_only" : null;
    }
    if (rec.record_type === "candidate" && rec.stage === "price_rejected") rec.reason_codes = ["backfill_no_risk_decision"];
    out.push(rec);
  }
  if (c.end?.marks?.length) {
    const base = { schema_version: out[0]?.schema_version, ts: c.end.ts, cycle_id: c.cycle_id, pipeline_run_id: c.pipeline_run_id, cycle_index: c.cycle_index, regime: c.regime, settings_hash: settingsHash };
    for (let i = 0; i < c.end.marks.length; i += PRICE_MARKS_PER_RECORD) {
      out.push({ ...base, record_type: "price_marks", marks: c.end.marks.slice(i, i + PRICE_MARKS_PER_RECORD), mark_point: "cycle_end", provenance: BACKFILL_PROVENANCE });
    }
  }
  return out;
}

export function buildBackfilledLedgerRecord(c) {
  const hash = backfilledSettingsHash(c.settings);
  if (!hash) return null;
  return {
    schema_version: "settings-ledger-v1",
    record_type: "settings_version",
    ts: c.ts || new Date(c.first_ms).toISOString(),
    settings_hash: hash,
    settings: redactSettingsForLedger(c.settings),
    settings_scope: "portfolio_overrides_only",
    cycle_id: c.cycle_id,
    provenance: BACKFILL_PROVENANCE
  };
}

// Pure, in-memory version (tests): events[] -> { snapshotRecords, ledgerRecords, stats }.
export function backfillFromEvents(events, options = {}) {
  const fromMs = toMs(options.from) ?? -Infinity;
  const toMsValue = toMs(options.to) ?? Infinity;
  const cycles = new Map();
  for (const e of events) addEventToCycle(cycles, e);
  const ordered = [...cycles.values()].sort((a, b) => a.first_ms - b.first_ms);
  const snapshotRecords = [];
  const ledgerRecords = [];
  const seenHashes = new Set();
  const stats = { cycles: 0, skipped_outside_window: 0 };
  for (const c of ordered) {
    if (c.first_ms < fromMs || c.first_ms > toMsValue) { stats.skipped_outside_window += 1; continue; }
    stats.cycles += 1;
    snapshotRecords.push(...buildBackfilledCycleRecords(c));
    const ledger = buildBackfilledLedgerRecord(c);
    if (ledger && !seenHashes.has(ledger.settings_hash)) { seenHashes.add(ledger.settings_hash); ledgerRecords.push(ledger); }
  }
  return { snapshotRecords, ledgerRecords, stats };
}

function summarize(records) {
  const s = { cycles: 0, candidates: 0, price_mark_records: 0, cycles_with_eth: 0, stages: {} };
  for (const r of records) {
    if (r.record_type === "cycle") { s.cycles += 1; if (r.eth_price_usd != null) s.cycles_with_eth += 1; }
    else if (r.record_type === "candidate") { s.candidates += 1; s.stages[r.stage] = (s.stages[r.stage] || 0) + 1; }
    else if (r.record_type === "price_marks") s.price_mark_records += 1;
  }
  return s;
}

// Streaming version for the real 100k-line / ~800 MB file. Cycles are flushed when
// their cycle_end arrives or when no event has been seen for them for 6 hours.
export async function backfillFile({ input, out, ledgerOut, from, to }) {
  const fromMs = toMs(from) ?? -Infinity;
  const toMsValue = toMs(to) ?? Infinity;
  const snapFd = fs.openSync(out, "w");
  const ledgerFd = fs.openSync(ledgerOut, "w");
  const cycles = new Map();
  const seenHashes = new Set();
  const totals = { lines: 0, malformed: 0, events_used: 0, cycles: 0, candidates: 0, price_mark_records: 0, cycles_with_eth: 0, settings_versions: 0, stages: {}, first_cycle: null, last_cycle: null };
  const flush = (c) => {
    cycles.delete(c.cycle_id);
    if (c.first_ms < fromMs || c.first_ms > toMsValue) return;
    const records = buildBackfilledCycleRecords(c);
    if (!records.length) return;
    fs.writeSync(snapFd, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = summarize(records);
    totals.cycles += s.cycles;
    totals.candidates += s.candidates;
    totals.price_mark_records += s.price_mark_records;
    totals.cycles_with_eth += s.cycles_with_eth;
    for (const [k, v] of Object.entries(s.stages)) totals.stages[k] = (totals.stages[k] || 0) + v;
    const iso = new Date(c.first_ms).toISOString();
    if (!totals.first_cycle || iso < totals.first_cycle) totals.first_cycle = iso;
    if (!totals.last_cycle || iso > totals.last_cycle) totals.last_cycle = iso;
    const ledger = buildBackfilledLedgerRecord(c);
    if (ledger && !seenHashes.has(ledger.settings_hash)) {
      seenHashes.add(ledger.settings_hash);
      fs.writeSync(ledgerFd, JSON.stringify(ledger) + "\n");
      totals.settings_versions += 1;
    }
  };
  const rl = readline.createInterface({ input: fs.createReadStream(input, { encoding: "utf8" }), crlfDelay: Infinity });
  const prefilter = RELEVANT_EVENTS.map((t) => `"${t}"`);
  for await (const line of rl) {
    totals.lines += 1;
    if (!prefilter.some((p) => line.includes(p))) continue;
    let event;
    try { event = JSON.parse(line); } catch { totals.malformed += 1; continue; }
    if (!addEventToCycle(cycles, event)) continue;
    totals.events_used += 1;
    const c = cycles.get(event.cycle_id);
    if (event.event_type === "cycle_end") flush(c);
    else if (event.event_type === "cycle_start") {
      const nowMs = toMs(event.ts);
      for (const other of [...cycles.values()]) if (other !== c && nowMs - other.last_ms > STALE_CYCLE_MS) flush(other);
    }
  }
  for (const c of [...cycles.values()].sort((a, b) => a.first_ms - b.first_ms)) flush(c);
  fs.closeSync(snapFd);
  fs.closeSync(ledgerFd);
  return totals;
}

function sameFile(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  try { return fs.realpathSync(ra) === fs.realpathSync(rb); } catch { return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || DEFAULT_FILES.trainingEvents;
  const out = args.out || DEFAULT_BACKFILL_FILES.snapshots;
  const ledgerOut = args["ledger-out"] || DEFAULT_BACKFILL_FILES.settingsLedger;
  if (!fs.existsSync(input)) { console.error(`input not found: ${input}`); process.exit(1); }
  for (const target of [out, ledgerOut]) {
    if (sameFile(target, input) || sameFile(target, DEFAULT_FILES.snapshots) || sameFile(target, DEFAULT_FILES.settingsLedger)) {
      console.error(`refusing to write ${target}: it is an input or a live log file`);
      process.exit(1);
    }
    if (fs.existsSync(target) && !args.force) { console.error(`${target} exists; pass --force to overwrite`); process.exit(1); }
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const totals = await backfillFile({ input, out, ledgerOut, from: args.from, to: args.to });
  console.log(JSON.stringify({ input, out, ledger_out: ledgerOut, ...totals }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
}
