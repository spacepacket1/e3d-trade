#!/usr/bin/env node
// Snapshot completeness: share of pipeline cycles (cycle_start events in
// logs/training-events.jsonl) that have a "cycle" record in
// logs/candidate-snapshots.jsonl. Cycles that abort before the snapshot hook, and every
// cycle from before the hook was deployed, show up as missing; the "since first
// snapshot" figure excludes the latter.
//
// Usage: node scripts/snapshotCompleteness.js [--from=ISO] [--to=ISO] [--json] | --fixture
import path from "path";
import { fileURLToPath } from "url";
import { SNAPSHOT_STAGES } from "./candidateSnapshots.js";
import { loadSnapshots, loadTrainingEvents, parseArgs, toMs } from "./evalData.js";

function share(a, b) {
  return b > 0 ? Math.round((a / b) * 10000) / 10000 : null;
}

export function buildCompletenessReport({ cycleStarts = [], snapshotRecords = [] }, options = {}) {
  const fromMs = toMs(options.from) ?? -Infinity;
  const toMsValue = toMs(options.to) ?? Infinity;
  const inWindow = (ts) => {
    const ms = toMs(ts);
    return ms != null && ms >= fromMs && ms <= toMsValue;
  };
  const snapshotCycles = new Map();
  const stageTotals = Object.fromEntries(SNAPSHOT_STAGES.map((s) => [s, 0]));
  let candidateRecords = 0;
  let firstSnapshotMs = null;
  for (const r of snapshotRecords) {
    if (!inWindow(r?.ts)) continue;
    if (r.record_type === "cycle" && r.cycle_id) {
      snapshotCycles.set(r.cycle_id, r);
      const ms = toMs(r.ts);
      firstSnapshotMs = firstSnapshotMs == null ? ms : Math.min(firstSnapshotMs, ms);
    } else if (r.record_type === "candidate") {
      candidateRecords += 1;
      if (r.stage in stageTotals) stageTotals[r.stage] += 1;
    }
  }
  const starts = cycleStarts.filter((c) => c?.cycle_id && inWindow(c.ts));
  const startIds = new Set(starts.map((c) => c.cycle_id));
  const covered = [...startIds].filter((id) => snapshotCycles.has(id));
  const startsSince = firstSnapshotMs == null ? [] : starts.filter((c) => toMs(c.ts) >= firstSnapshotMs);
  const coveredSince = startsSince.filter((c) => snapshotCycles.has(c.cycle_id)).length;
  const missing = starts.filter((c) => !snapshotCycles.has(c.cycle_id)).map((c) => c.cycle_id);
  const withUniverse = [...snapshotCycles.values()].filter((r) => r.universe_captured).length;
  return {
    window: { from: options.from || null, to: options.to || null },
    cycles_started: startIds.size,
    cycles_with_snapshot: covered.length,
    completeness_share: share(covered.length, startIds.size),
    first_snapshot_at: firstSnapshotMs != null ? new Date(firstSnapshotMs).toISOString() : null,
    cycles_started_since_first_snapshot: startsSince.length,
    completeness_share_since_first_snapshot: share(coveredSince, startsSince.length),
    snapshot_cycles_without_cycle_start: [...snapshotCycles.keys()].filter((id) => !startIds.has(id)).length,
    snapshot_cycles_with_universe: withUniverse,
    universe_share: share(withUniverse, snapshotCycles.size),
    candidate_records: candidateRecords,
    candidates_per_snapshot_cycle: snapshotCycles.size ? Math.round((candidateRecords / snapshotCycles.size) * 100) / 100 : null,
    stage_totals: stageTotals,
    missing_cycle_ids_sample: missing.slice(0, 10)
  };
}

export function formatCompleteness(r) {
  const pct = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  return [
    "SNAPSHOT COMPLETENESS",
    `cycles started: ${r.cycles_started}   with snapshot: ${r.cycles_with_snapshot}   share: ${pct(r.completeness_share)}`,
    `since first snapshot (${r.first_snapshot_at || "none"}): ${r.cycles_started_since_first_snapshot} cycles, share ${pct(r.completeness_share_since_first_snapshot)}`,
    `snapshot cycles with scout universe captured: ${r.snapshot_cycles_with_universe} (${pct(r.universe_share)})`,
    `candidate records: ${r.candidate_records} (${r.candidates_per_snapshot_cycle ?? "n/a"} per cycle)`,
    `stages: ${Object.entries(r.stage_totals).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    r.missing_cycle_ids_sample.length ? `missing (sample): ${r.missing_cycle_ids_sample.join(", ")}` : "missing: none"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let inputs;
  if (args.fixture) {
    const { buildEvalFixture } = await import("./evalFixture.js");
    const f = buildEvalFixture({ seed: args["fixture-seed"] || "fixture" });
    inputs = { cycleStarts: f.cycleStarts, snapshotRecords: f.snapshotRecords };
    console.log("(synthetic fixture; no logs read)");
  } else {
    const [snaps, events] = await Promise.all([loadSnapshots(), loadTrainingEvents()]);
    if (!snaps.stats.exists) console.log("note: logs/candidate-snapshots.jsonl not found");
    if (!events.stats.exists) console.log("note: logs/training-events.jsonl not found");
    inputs = { cycleStarts: events.cycleStarts, snapshotRecords: snaps.records };
  }
  const report = buildCompletenessReport(inputs, { from: args.from, to: args.to });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatCompleteness(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
}
