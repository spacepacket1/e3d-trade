#!/usr/bin/env node
// Baseline comparison for the paper desk. Offline, read-only, deterministic given --seed.
//
// Compares the system's closed trades in a window against, net of the paper cost model
// (scripts/evalCostModel.js mirrors pipeline.js buildPaperFillExecution):
//   (a) ETH held over the same entry->exit interval as each system trade (paired),
//       plus the window buy-and-hold ETH return for reference;
//   (b) an equal-weight book of the approved candidates, each held for the median
//       system holding duration, under the evaluation exit rule;
//   (c) random entries: for each system trade, a candidate drawn uniformly from the
//       same cycle's gated universe, held under the evaluation exit rule with the same
//       holding duration (N seeded draws);
//   (d) the system's actual trades.
// Each comparison reports excess return with a bootstrap 95% CI, trade count, distinct
// days and distinct tokens. Below 100 entries or 30 distinct days the verdict is
// "INSUFFICIENT DATA" with the shortfall.
//
// Evaluation exit rule (baselines only; the system's own trades use their real exits):
// stop at default_stop_distance_pct below entry, sell target_partial_pct at the first
// target multiple, exit the rest at the holding duration. Trailing stops, ATR stops and
// harvest/LLM exits are NOT modelled. Settings come from the settings ledger for the
// trade's settings hash when available, otherwise from the mirrored defaults.
//
// Usage:
//   node scripts/baselineCompare.js [--from=ISO] [--to=ISO] [--seed=42] [--draws=1000]
//        [--universe=gate|all] [--include-trend-sleeve] [--json]
//   node scripts/baselineCompare.js --fixture=null|edge [--seed=..]   (synthetic data, no logs read)
import path from "path";
import { fileURLToPath } from "url";
import { ETH_SLEEVE_EXECUTION, netRoundTripReturn, resolveExitRules } from "./evalCostModel.js";
import {
  DEFAULT_FILES, WETH_ADDRESS, buildClosedPositions, loadSettingsLedger, loadSnapshots,
  loadTrainingEvents, parseArgs, toMs, utcDay
} from "./evalData.js";
import { bootstrapDiffCi, bootstrapMeanCi, createRng, mean, median, percentileCi, randInt } from "./evalStats.js";

export const MIN_ENTRIES = 100;
export const MIN_DISTINCT_DAYS = 30;
const HOUR_MS = 3600 * 1000;
const GATE_STAGES = new Set(["gate_rejected", "risk_vetoed", "approved", "bought"]);
const APPROVED_STAGES = new Set(["approved", "bought"]);

function round(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function insertPoint(series, address, ms, price, liquidity) {
  if (!address || ms == null || !(price > 0)) return;
  if (!series.has(address)) series.set(address, []);
  series.get(address).push({ ms, price, liquidity: Number.isFinite(liquidity) ? liquidity : null });
}

export function buildMarketIndex(snapshotRecords = []) {
  const cycles = new Map();
  const series = new Map();
  for (const r of snapshotRecords) {
    const ms = toMs(r?.ts);
    if (ms == null || !r?.cycle_id) continue;
    if (!cycles.has(r.cycle_id)) cycles.set(r.cycle_id, { cycle_id: r.cycle_id, ms, candidates: [], settings_hash: r.settings_hash || null });
    const cycle = cycles.get(r.cycle_id);
    cycle.ms = Math.min(cycle.ms, ms);
    if (r.record_type === "cycle") {
      insertPoint(series, WETH_ADDRESS, ms, Number(r.eth_price_usd), null);
    } else if (r.record_type === "candidate") {
      const address = String(r.token_address || "").toLowerCase();
      const price = Number(r.price_usd);
      if (address && price > 0) {
        cycle.candidates.push({ address, symbol: r.symbol, stage: r.stage, price, liquidity: Number(r.liquidity_usd), slippage: r.slippage_bps });
        insertPoint(series, address, ms, price, Number(r.liquidity_usd));
      }
    } else if (r.record_type === "price_marks" && Array.isArray(r.marks)) {
      for (const mark of r.marks) {
        if (Array.isArray(mark)) insertPoint(series, String(mark[0] || "").toLowerCase(), ms, Number(mark[1]), Number(mark[2]));
      }
    }
  }
  for (const [address, points] of series) {
    points.sort((a, b) => a.ms - b.ms);
    const deduped = points.filter((p, i) => i === 0 || p.ms !== points[i - 1].ms);
    series.set(address, deduped);
  }
  const cycleList = [...cycles.values()].sort((a, b) => a.ms - b.ms);
  return { cycles, cycleList, series };
}

function firstIndexAfter(points, ms) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ms <= ms) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function priceNear(points, targetMs, toleranceMs) {
  if (!points?.length) return null;
  const idx = firstIndexAfter(points, targetMs);
  let best = null;
  for (const candidate of [points[idx - 1], points[idx]]) {
    if (!candidate) continue;
    const gap = Math.abs(candidate.ms - targetMs);
    if (gap <= toleranceMs && (!best || gap < Math.abs(best.ms - targetMs))) best = candidate;
  }
  return best;
}

// Simulate one $1 entry under the evaluation exit rule. Returns null when unpriceable.
export function simulateEntry({ points, entryMs, entryPrice, entryLiquidity, entrySlippage, holdMs, rules, toleranceMs }) {
  if (!points?.length || !(entryPrice > 0) || !(holdMs > 0)) return null;
  const endMs = entryMs + holdMs;
  const stopPrice = entryPrice * (1 - rules.stop_distance_pct);
  const targetPrice = entryPrice * rules.target_1_multiple;
  const legs = [];
  let remaining = 1;
  let targetHit = false;
  let exitReason = "time";
  for (let i = firstIndexAfter(points, entryMs); i < points.length && points[i].ms <= endMs; i += 1) {
    const p = points[i];
    if (p.price <= stopPrice) {
      legs.push({ fraction: remaining, price: p.price, liquidityUsd: p.liquidity ?? entryLiquidity });
      remaining = 0;
      exitReason = "stop";
      break;
    }
    if (!targetHit && p.price >= targetPrice && rules.target_partial_pct > 0) {
      const fraction = remaining * rules.target_partial_pct;
      legs.push({ fraction, price: p.price, liquidityUsd: p.liquidity ?? entryLiquidity });
      remaining -= fraction;
      targetHit = true;
    }
  }
  if (remaining > 1e-12) {
    const end = priceNear(points, endMs, toleranceMs);
    if (!end || end.ms <= entryMs) return null;
    legs.push({ fraction: remaining, price: end.price, liquidityUsd: end.liquidity ?? entryLiquidity });
  }
  const ret = netRoundTripReturn({
    entryPrice,
    entryLiquidityUsd: Number.isFinite(entryLiquidity) ? entryLiquidity : null,
    entrySlippageBps: entrySlippage,
    legs,
    feeBps: rules.fee_bps_per_side
  });
  return ret == null ? null : { net_return: ret, exit_reason: exitReason };
}

function verdictFor(stats, minEntries, minDays) {
  const shortEntries = Math.max(0, minEntries - stats.n);
  const shortDays = Math.max(0, minDays - stats.distinct_days);
  if (shortEntries || shortDays) {
    return {
      verdict: "INSUFFICIENT DATA",
      shortfall: { entries_needed: minEntries, entries_have: stats.n, entries_short: shortEntries, days_needed: minDays, days_have: stats.distinct_days, days_short: shortDays }
    };
  }
  const [lo, hi] = stats.excess_ci95 || [null, null];
  if (lo == null || hi == null) return { verdict: "INSUFFICIENT DATA", shortfall: { reason: "confidence interval unavailable" } };
  if (lo > 0) return { verdict: "OUTPERFORMS (95% CI above 0)", shortfall: null };
  if (hi < 0) return { verdict: "UNDERPERFORMS (95% CI below 0)", shortfall: null };
  return { verdict: "NO SIGNIFICANT DIFFERENCE (95% CI includes 0)", shortfall: null };
}

function describeTrades(trades) {
  return {
    n: trades.length,
    distinct_days: new Set(trades.map((t) => utcDay(t.entry_ms))).size,
    distinct_tokens: new Set(trades.map((t) => t.contract_address || t.symbol)).size
  };
}

function rulesForHash(hash, settingsByHash) {
  return resolveExitRules(hash && settingsByHash.has(hash) ? settingsByHash.get(hash) : null);
}

export function compareBaselines({ snapshotRecords = [], closedPositions = [], settingsLedgerRecords = [] }, options = {}) {
  const seed = options.seed ?? 42;
  const draws = Math.max(10, Math.trunc(options.draws ?? 1000));
  const minEntries = options.minEntries ?? MIN_ENTRIES;
  const minDays = options.minDays ?? MIN_DISTINCT_DAYS;
  const toleranceMs = options.priceToleranceMs ?? 12 * HOUR_MS;
  const universeMode = options.universe === "all" ? "all" : "gate";
  const fromMs = toMs(options.from) ?? -Infinity;
  const toMsValue = toMs(options.to) ?? Infinity;

  const settingsByHash = new Map();
  for (const r of settingsLedgerRecords) if (r?.settings_hash && r.settings) settingsByHash.set(r.settings_hash, r.settings);
  const market = buildMarketIndex(snapshotRecords);
  const ethPoints = market.series.get(WETH_ADDRESS) || [];

  const systemTrades = closedPositions
    .filter((t) => t.entry_ms >= fromMs && t.entry_ms <= toMsValue)
    .filter((t) => options.includeTrendSleeve || String(t.contract_address || "").toLowerCase() !== WETH_ADDRESS);

  const report = {
    generated_with: { seed: String(seed), draws, universe: universeMode, price_tolerance_hours: toleranceMs / HOUR_MS, min_entries: minEntries, min_distinct_days: minDays },
    window: { from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null, to: Number.isFinite(toMsValue) ? new Date(toMsValue).toISOString() : null },
    inputs: { snapshot_cycles: market.cycleList.length, priced_tokens: market.series.size, eth_price_points: ethPoints.length, closed_positions_in_window: systemTrades.length, settings_versions_known: settingsByHash.size },
    exit_rule_note: "Baselines use a simplified exit rule (fixed stop, first-target partial, time exit). The system's own trades use their real exits.",
    system: null,
    baselines: {}
  };

  // (d) system
  const sysReturns = systemTrades.map((t) => t.net_return);
  const rngSys = createRng(`${seed}:system`);
  report.system = {
    ...describeTrades(systemTrades),
    mean_net_return: round(mean(sysReturns)),
    mean_net_return_ci95: bootstrapMeanCi(sysReturns, rngSys, draws).map((v) => round(v)),
    median_holding_hours: round((median(systemTrades.map((t) => t.holding_ms)) ?? NaN) / HOUR_MS, 2)
  };

  // (a) ETH, paired over each trade's interval
  {
    const paired = [];
    for (const t of systemTrades) {
      const a = priceNear(ethPoints, t.entry_ms, toleranceMs);
      const b = priceNear(ethPoints, t.exit_ms, toleranceMs);
      if (!a || !b || b.ms <= a.ms) continue;
      const eth = netRoundTripReturn({
        entryPrice: a.price, entryLiquidityUsd: ETH_SLEEVE_EXECUTION.liquidity_usd, entrySlippageBps: ETH_SLEEVE_EXECUTION.estimated_slippage_bps,
        legs: [{ fraction: 1, price: b.price, liquidityUsd: ETH_SLEEVE_EXECUTION.liquidity_usd }],
        feeBps: rulesForHash(t.entry_settings_hash, settingsByHash).fee_bps_per_side
      });
      if (eth != null) paired.push({ trade: t, sys: t.net_return, base: eth });
    }
    const diffs = paired.map((p) => p.sys - p.base);
    const stats = {
      ...describeTrades(paired.map((p) => p.trade)),
      system_mean_net_return: round(mean(paired.map((p) => p.sys))),
      baseline_mean_net_return: round(mean(paired.map((p) => p.base))),
      excess_mean: round(mean(diffs)),
      excess_ci95: bootstrapMeanCi(diffs, createRng(`${seed}:eth`), draws).map((v) => round(v))
    };
    const inWindow = ethPoints.filter((p) => p.ms >= fromMs && p.ms <= toMsValue);
    const windowHold = inWindow.length >= 2 ? netRoundTripReturn({
      entryPrice: inWindow[0].price, entryLiquidityUsd: ETH_SLEEVE_EXECUTION.liquidity_usd, entrySlippageBps: ETH_SLEEVE_EXECUTION.estimated_slippage_bps,
      legs: [{ fraction: 1, price: inWindow[inWindow.length - 1].price, liquidityUsd: ETH_SLEEVE_EXECUTION.liquidity_usd }]
    }) : null;
    report.baselines.buy_and_hold_eth = {
      description: "ETH bought at each system entry time and sold at its exit time (paired), net of costs",
      ...stats,
      window_buy_and_hold_net_return: round(windowHold),
      unpaired_trades: systemTrades.length - paired.length,
      ...verdictFor(stats, minEntries, minDays)
    };
  }

  // Pair system trades with their entry cycle (by cycle id, else latest cycle <= entry within tolerance).
  const pairCycle = (t) => {
    if (t.entry_cycle_id && market.cycles.has(t.entry_cycle_id)) return market.cycles.get(t.entry_cycle_id);
    let best = null;
    for (const c of market.cycleList) {
      if (c.ms > t.entry_ms) break;
      if (t.entry_ms - c.ms <= toleranceMs) best = c;
    }
    return best;
  };

  const cache = new Map();
  const simulateCandidate = (cycle, cand, holdMs) => {
    const key = `${cycle.cycle_id}|${cand.address}|${holdMs}`;
    if (cache.has(key)) return cache.get(key);
    const result = simulateEntry({
      points: market.series.get(cand.address), entryMs: cycle.ms, entryPrice: cand.price, entryLiquidity: cand.liquidity,
      entrySlippage: cand.slippage, holdMs, rules: rulesForHash(cycle.settings_hash, settingsByHash), toleranceMs
    });
    const value = result ? result.net_return : null;
    cache.set(key, value);
    return value;
  };

  // (b) equal weight of approved candidates in window cycles, median system hold
  {
    const holdMs = median(systemTrades.map((t) => t.holding_ms));
    const ewReturns = [];
    const ewEntries = [];
    if (holdMs > 0) {
      for (const cycle of market.cycleList) {
        if (cycle.ms < fromMs || cycle.ms > toMsValue) continue;
        for (const cand of cycle.candidates) {
          if (!APPROVED_STAGES.has(cand.stage)) continue;
          const r = simulateCandidate(cycle, cand, holdMs);
          if (r == null) continue;
          ewReturns.push(r);
          ewEntries.push({ entry_ms: cycle.ms, contract_address: cand.address });
        }
      }
    }
    const ewStats = describeTrades(ewEntries);
    const stats = {
      n: report.system.n,
      distinct_days: report.system.distinct_days,
      distinct_tokens: report.system.distinct_tokens,
      baseline_entries: ewStats.n,
      baseline_distinct_days: ewStats.distinct_days,
      baseline_distinct_tokens: ewStats.distinct_tokens,
      hold_hours: round((holdMs ?? NaN) / HOUR_MS, 2),
      system_mean_net_return: round(mean(sysReturns)),
      baseline_mean_net_return: round(mean(ewReturns)),
      excess_mean: ewReturns.length && sysReturns.length ? round(mean(sysReturns) - mean(ewReturns)) : null,
      excess_ci95: bootstrapDiffCi(sysReturns, ewReturns, createRng(`${seed}:ew`), draws).map((v) => round(v))
    };
    // Both samples must clear the minimums: the system's trades and the baseline's entries.
    const limiting = {
      ...stats,
      n: Math.min(stats.n, ewStats.n),
      distinct_days: Math.min(stats.distinct_days, ewStats.distinct_days)
    };
    report.baselines.equal_weight_approved = {
      description: "Every approved candidate in the window, equal weight, held for the median system holding time, evaluation exit rule",
      ...stats,
      ...verdictFor(limiting, minEntries, minDays)
    };
  }

  // (c) random entries from the same cycle's universe, same hold as the paired system trade
  {
    const comparable = [];
    let unpairedCycle = 0;
    let noPriceable = 0;
    for (const t of systemTrades) {
      const cycle = pairCycle(t);
      if (!cycle) { unpairedCycle += 1; continue; }
      const universe = cycle.candidates.filter((c) => universeMode === "all" || GATE_STAGES.has(c.stage));
      const values = [];
      for (const cand of universe) {
        const r = simulateCandidate(cycle, cand, t.holding_ms);
        if (r != null) values.push(r);
      }
      if (!values.length) { noPriceable += 1; continue; }
      comparable.push({ trade: t, sys: t.net_return, values, expected: mean(values) });
    }
    const rng = createRng(`${seed}:random`);
    const n = comparable.length;
    const drawMeans = [];
    const diffSamples = [];
    for (let d = 0; d < draws && n > 0; d += 1) {
      let drawSum = 0;
      for (const c of comparable) drawSum += c.values[randInt(rng, c.values.length)];
      drawMeans.push(drawSum / n);
      let diffSum = 0;
      for (let i = 0; i < n; i += 1) {
        const c = comparable[randInt(rng, n)];
        diffSum += c.sys - c.values[randInt(rng, c.values.length)];
      }
      diffSamples.push(diffSum / n);
    }
    const sysMean = mean(comparable.map((c) => c.sys));
    const stats = {
      ...describeTrades(comparable.map((c) => c.trade)),
      draws: drawMeans.length,
      mean_universe_size: round(mean(comparable.map((c) => c.values.length)), 2),
      system_mean_net_return: round(sysMean),
      random_mean_net_return: round(mean(drawMeans)),
      random_draw_mean_ci95: drawMeans.length ? percentileCi(drawMeans).map((v) => round(v)) : [null, null],
      excess_mean: n ? round(mean(comparable.map((c) => c.sys - c.expected))) : null,
      excess_ci95: diffSamples.length ? percentileCi(diffSamples).map((v) => round(v)) : [null, null],
      p_value_one_sided: drawMeans.length ? round(drawMeans.filter((m) => m >= sysMean).length / drawMeans.length, 4) : null,
      unpaired_trades: unpairedCycle,
      trades_without_priceable_universe: noPriceable
    };
    report.baselines.random_entry = {
      description: `Random entry from the same cycle's ${universeMode === "gate" ? "gated universe (candidates that reached the buy gate)" : "full candidate universe"}, same holding time, evaluation exit rule`,
      ...stats,
      ...verdictFor(stats, minEntries, minDays)
    };
  }

  return report;
}

function fmtPct(v) {
  return v == null ? "n/a" : `${(v * 100).toFixed(2)}%`;
}

function fmtCi(ci) {
  return ci && ci[0] != null ? `[${fmtPct(ci[0])}, ${fmtPct(ci[1])}]` : "n/a";
}

export function formatReport(report) {
  const lines = [];
  lines.push("BASELINE COMPARISON (net of paper cost model; returns are per entry, equal notional)");
  lines.push(`window: ${report.window.from || "start"} -> ${report.window.to || "end"}   seed=${report.generated_with.seed} draws=${report.generated_with.draws} universe=${report.generated_with.universe}`);
  lines.push(`inputs: ${report.inputs.snapshot_cycles} snapshot cycles, ${report.inputs.priced_tokens} priced tokens, ${report.inputs.eth_price_points} ETH points, ${report.inputs.closed_positions_in_window} closed positions, ${report.inputs.settings_versions_known} settings versions`);
  const s = report.system;
  lines.push(`(d) system: n=${s.n} days=${s.distinct_days} tokens=${s.distinct_tokens} mean=${fmtPct(s.mean_net_return)} CI95=${fmtCi(s.mean_net_return_ci95)} median hold=${s.median_holding_hours == null ? "n/a" : `${s.median_holding_hours}h`}`);
  const labels = { buy_and_hold_eth: "(a) buy-and-hold ETH", equal_weight_approved: "(b) equal-weight approved", random_entry: "(c) random entry" };
  for (const [key, label] of Object.entries(labels)) {
    const b = report.baselines[key];
    if (!b) continue;
    const base = b.baseline_mean_net_return ?? b.random_mean_net_return;
    lines.push(`${label}: n=${b.n} days=${b.distinct_days} tokens=${b.distinct_tokens} baseline mean=${fmtPct(base)} excess=${fmtPct(b.excess_mean)} CI95=${fmtCi(b.excess_ci95)}${b.p_value_one_sided != null ? ` p=${b.p_value_one_sided}` : ""}`);
    if (b.window_buy_and_hold_net_return !== undefined) lines.push(`    window buy-and-hold ETH (net): ${fmtPct(b.window_buy_and_hold_net_return)}`);
    if (b.baseline_entries !== undefined) lines.push(`    baseline entries=${b.baseline_entries} days=${b.baseline_distinct_days} tokens=${b.baseline_distinct_tokens} hold=${b.hold_hours == null ? "n/a" : `${b.hold_hours}h`}`);
    if (b.verdict === "INSUFFICIENT DATA" && b.shortfall) {
      const sf = b.shortfall;
      lines.push(`    verdict: INSUFFICIENT DATA${sf.reason ? ` (${sf.reason})` : ` (entries ${sf.entries_have}/${sf.entries_needed}, short ${sf.entries_short}; distinct days ${sf.days_have}/${sf.days_needed}, short ${sf.days_short})`}`);
    } else {
      lines.push(`    verdict: ${b.verdict}`);
    }
  }
  lines.push(report.exit_rule_note);
  return lines.join("\n");
}

export async function loadRealInputs(files = DEFAULT_FILES) {
  const [snap, ledger, events] = await Promise.all([
    loadSnapshots(files.snapshots), loadSettingsLedger(files.settingsLedger), loadTrainingEvents(files.trainingEvents)
  ]);
  return {
    snapshotRecords: snap.records,
    settingsLedgerRecords: ledger.records,
    closedPositions: buildClosedPositions(events.tradeEvents),
    cycleStarts: events.cycleStarts,
    fileStats: { snapshots: snap.stats, settings_ledger: ledger.stats, training_events: events.stats }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let inputs;
  if (args.fixture) {
    const { buildEvalFixture } = await import("./evalFixture.js");
    const fixture = buildEvalFixture({ edge: args.fixture === "edge", seed: args["fixture-seed"] || "fixture", days: Number(args["fixture-days"] || 60) });
    inputs = { snapshotRecords: fixture.snapshotRecords, settingsLedgerRecords: fixture.settingsLedgerRecords, closedPositions: buildClosedPositions(fixture.tradeEvents) };
    console.log(`(synthetic fixture: ${args.fixture === "edge" ? "planted edge" : "edge-free"}; no logs read)`);
  } else {
    inputs = await loadRealInputs();
    if (!inputs.fileStats.snapshots.exists) console.log("note: logs/candidate-snapshots.jsonl not found; (b) and (c) need snapshot data. Try --fixture=null or --fixture=edge for a demo.");
  }
  const report = compareBaselines(inputs, {
    seed: args.seed ?? 42, draws: args.draws ? Number(args.draws) : 1000, from: args.from, to: args.to,
    universe: args.universe, includeTrendSleeve: Boolean(args["include-trend-sleeve"])
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
}
