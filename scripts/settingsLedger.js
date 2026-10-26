#!/usr/bin/env node
// Settings ledger: which settings hash was active when, which parameters changed
// between versions, and per version the closed-trade count and expectancy, so a
// tuning change can be judged on the trades it actually governed.
//
// Sources (read-only): logs/settings-ledger.jsonl (hash -> settings, written by the
// candidate snapshot hook), logs/candidate-snapshots.jsonl (cycle records carry the
// active hash), logs/training-events.jsonl (trade events; new trades carry settings_hash).
// Closed positions are attributed to the hash active at ENTRY. Trades written before
// this field existed are grouped as "unhashed".
//
// Usage: node scripts/settingsLedger.js [--json] | --fixture
import path from "path";
import { fileURLToPath } from "url";
import {
  buildClosedPositions, loadSettingsLedger, loadSnapshots, loadTrainingEvents, parseArgs, toMs
} from "./evalData.js";
import { mean } from "./evalStats.js";
import { stableStringify } from "./settingsHash.js";

const UNHASHED = "unhashed";

function round(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function diffSettings(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const changes = [];
  for (const key of keys) {
    const a = before?.[key];
    const b = after?.[key];
    if (stableStringify(a) !== stableStringify(b)) changes.push({ key, from: a ?? null, to: b ?? null });
  }
  return changes;
}

export function buildSettingsLedgerReport({ settingsLedgerRecords = [], snapshotRecords = [], closedPositions = [] }) {
  const versions = new Map();
  const touch = (hash, ms) => {
    if (!hash) return null;
    if (!versions.has(hash)) versions.set(hash, { settings_hash: hash, first_seen_ms: ms, last_seen_ms: ms, cycles: new Set(), settings: null });
    const v = versions.get(hash);
    if (ms != null) {
      v.first_seen_ms = v.first_seen_ms == null ? ms : Math.min(v.first_seen_ms, ms);
      v.last_seen_ms = v.last_seen_ms == null ? ms : Math.max(v.last_seen_ms, ms);
    }
    return v;
  };
  for (const r of settingsLedgerRecords) {
    const v = touch(r.settings_hash, toMs(r.ts));
    if (v && r.settings && !v.settings) v.settings = r.settings;
  }
  for (const r of snapshotRecords) {
    if (r?.record_type !== "cycle") continue;
    const v = touch(r.settings_hash, toMs(r.ts));
    if (v && r.cycle_id) v.cycles.add(r.cycle_id);
  }
  const tradesByHash = new Map();
  for (const t of closedPositions) {
    const hash = t.entry_settings_hash || UNHASHED;
    if (hash !== UNHASHED) touch(hash, t.entry_ms);
    if (!tradesByHash.has(hash)) tradesByHash.set(hash, []);
    tradesByHash.get(hash).push(t);
  }
  const ordered = [...versions.values()].sort((a, b) => (a.first_seen_ms ?? 0) - (b.first_seen_ms ?? 0));
  const rows = [];
  let previous = null;
  for (const v of ordered) {
    const trades = tradesByHash.get(v.settings_hash) || [];
    rows.push(summarizeVersion(v.settings_hash, trades, {
      first_seen: v.first_seen_ms != null ? new Date(v.first_seen_ms).toISOString() : null,
      last_seen: v.last_seen_ms != null ? new Date(v.last_seen_ms).toISOString() : null,
      cycles: v.cycles.size,
      settings_known: Boolean(v.settings),
      changed_from_previous: previous && v.settings && previous.settings ? diffSettings(previous.settings, v.settings) : null
    }));
    previous = v;
  }
  if (tradesByHash.has(UNHASHED)) {
    rows.push(summarizeVersion(UNHASHED, tradesByHash.get(UNHASHED), { first_seen: null, last_seen: null, cycles: null, settings_known: false, changed_from_previous: null }));
  }
  return { versions: rows, total_closed_positions: closedPositions.length };
}

function summarizeVersion(hash, trades, extra) {
  const pnl = trades.map((t) => t.pnl_usd);
  const returns = trades.map((t) => t.net_return);
  const wins = trades.filter((t) => t.pnl_usd > 0).length;
  return {
    settings_hash: hash,
    ...extra,
    closed_trades: trades.length,
    expectancy_usd: round(mean(pnl), 2),
    mean_net_return: round(mean(returns)),
    win_rate: trades.length ? round(wins / trades.length, 4) : null,
    total_pnl_usd: round(pnl.reduce((s, v) => s + v, 0), 2),
    distinct_entry_days: new Set(trades.map((t) => new Date(t.entry_ms).toISOString().slice(0, 10))).size
  };
}

export function formatSettingsLedger(report) {
  const lines = ["SETTINGS LEDGER (closed positions attributed to the settings hash active at entry)"];
  if (!report.versions.length) lines.push("no settings versions or trades found");
  for (const v of report.versions) {
    lines.push(`${v.settings_hash}  ${v.first_seen || "?"} -> ${v.last_seen || "?"}  cycles=${v.cycles ?? "n/a"}  closed=${v.closed_trades}  expectancy=$${v.expectancy_usd ?? "n/a"}  mean_return=${v.mean_net_return == null ? "n/a" : (v.mean_net_return * 100).toFixed(2) + "%"}  win_rate=${v.win_rate ?? "n/a"}  days=${v.distinct_entry_days}`);
    if (v.changed_from_previous?.length) {
      for (const c of v.changed_from_previous.slice(0, 20)) lines.push(`    changed ${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
    }
    if (v.closed_trades > 0 && v.closed_trades < 100) lines.push("    (fewer than 100 closed trades: expectancy is descriptive only, not evidence)");
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let inputs;
  if (args.fixture) {
    const { buildEvalFixture } = await import("./evalFixture.js");
    const f = buildEvalFixture({ edge: args.fixture === "edge", seed: args["fixture-seed"] || "fixture" });
    inputs = { settingsLedgerRecords: f.settingsLedgerRecords, snapshotRecords: f.snapshotRecords, closedPositions: buildClosedPositions(f.tradeEvents) };
    console.log("(synthetic fixture; no logs read)");
  } else {
    const [ledger, snaps, events] = await Promise.all([loadSettingsLedger(), loadSnapshots(), loadTrainingEvents()]);
    inputs = { settingsLedgerRecords: ledger.records, snapshotRecords: snaps.records, closedPositions: buildClosedPositions(events.tradeEvents) };
  }
  const report = buildSettingsLedgerReport(inputs);
  console.log(args.json ? JSON.stringify(report, null, 2) : formatSettingsLedger(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
}
