// Offline checks for scripts/baselineCompare.js on synthetic data where the answer is
// known, plus parity of the evaluation cost model with pipeline.js.
import assert from "assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = () => {};
const pipeline = await import("../pipeline.js");
fs.appendFileSync = originalAppendFileSync;

const { compareBaselines, formatReport, simulateEntry, priceNear, MIN_ENTRIES, MIN_DISTINCT_DAYS } = await import("./baselineCompare.js");
const { buildEvalFixture } = await import("./evalFixture.js");
const { buildClosedPositions } = await import("./evalData.js");
const cost = await import("./evalCostModel.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(fixtureOptions, options = {}) {
  const f = buildEvalFixture(fixtureOptions);
  return compareBaselines({
    snapshotRecords: f.snapshotRecords, settingsLedgerRecords: f.settingsLedgerRecords, closedPositions: buildClosedPositions(f.tradeEvents)
  }, { seed: 11, draws: 1000, ...options });
}

// 1. Cost model parity with pipeline.js (the mirror must not drift).
for (const key of Object.keys(cost.EVAL_SETTINGS_DEFAULTS)) {
  assert.deepEqual(cost.EVAL_SETTINGS_DEFAULTS[key], pipeline.SETTINGS_DEFAULTS[key], `mirror of SETTINGS_DEFAULTS.${key}`);
}
for (const side of ["buy", "sell"]) {
  for (const liquidity of [0, 5000, 20000, 150000, 1000000, 5e9]) {
    const exec = pipeline.buildPaperFillExecution({ side, price: 1, quantity: 100, cost_usd: 100, liquidity_usd: liquidity, settings: pipeline.SETTINGS_DEFAULTS });
    assert.equal(cost.slippageBpsFor(side, liquidity), exec.slippage_bps, `${side} slippage at liquidity ${liquidity}`);
    assert.equal(exec.fee_bps, cost.EVAL_SETTINGS_DEFAULTS.fee_bps_per_side);
  }
}
{
  // Round trip: buy $100 at 1.0 then sell everything at 1.1, 50 bps estimated slippage.
  const buy = pipeline.buildPaperFillExecution({ side: "buy", price: 1, cost_usd: 100, execution_data: { estimated_slippage_bps: 50 }, settings: pipeline.SETTINGS_DEFAULTS });
  const sell = pipeline.buildPaperFillExecution({ side: "sell", price: 1.1, quantity: buy.quantity, execution_data: { estimated_slippage_bps: 50 }, settings: pipeline.SETTINGS_DEFAULTS });
  const expected = (sell.filled_notional_usd - sell.fee_usd) / (buy.filled_notional_usd + buy.fee_usd) - 1;
  const got = cost.netRoundTripReturn({ entryPrice: 1, entrySlippageBps: 50, legs: [{ fraction: 1, price: 1.1 }] });
  assert.ok(Math.abs(got - expected) < 1e-12, `round trip ${got} vs ${expected}`);
}
{
  const src = fs.readFileSync(path.join(__dirname, "..", "pipeline.js"), "utf8");
  const start = src.indexOf("function buildTrendSleeveCandidate");
  const body = src.slice(start, start + 2000);
  assert.ok(body.includes("liquidity_usd: 5_000_000_000") && cost.ETH_SLEEVE_EXECUTION.liquidity_usd === 5_000_000_000);
  assert.ok(body.includes(`estimated_slippage_bps: ${cost.ETH_SLEEVE_EXECUTION.estimated_slippage_bps}`));
}

// 2. Exit rule mechanics on a hand-made path.
{
  const rules = cost.resolveExitRules(null);
  const pts = (prices) => prices.map((price, i) => ({ ms: i * 3600e3, price, liquidity: 2e6 }));
  const stop = simulateEntry({ points: pts([1, 0.9, 0.7, 2]), entryMs: 0, entryPrice: 1, entryLiquidity: 2e6, holdMs: 3 * 3600e3, rules, toleranceMs: 3600e3 });
  assert.equal(stop.exit_reason, "stop");
  assert.ok(stop.net_return < -0.29);
  const target = simulateEntry({ points: pts([1, 1.6, 1.0, 1.0]), entryMs: 0, entryPrice: 1, entryLiquidity: 2e6, holdMs: 3 * 3600e3, rules, toleranceMs: 3600e3 });
  assert.equal(target.exit_reason, "time");
  const expected = cost.netRoundTripReturn({ entryPrice: 1, entryLiquidityUsd: 2e6, legs: [{ fraction: 0.25, price: 1.6, liquidityUsd: 2e6 }, { fraction: 0.75, price: 1.0, liquidityUsd: 2e6 }] });
  assert.ok(Math.abs(target.net_return - expected) < 1e-12, "partial at first target then time exit");
  assert.equal(simulateEntry({ points: pts([1]), entryMs: 0, entryPrice: 1, holdMs: 10 * 3600e3, rules, toleranceMs: 3600e3 }), null, "no exit price -> unpriceable");
  assert.equal(priceNear(pts([1, 2, 3]), 1.4 * 3600e3, 0.5 * 3600e3).price, 2);
  assert.equal(priceNear(pts([1, 2, 3]), 10 * 3600e3, 3600e3), null);
}

// 3. Edge-free system: no significant excess over random entries (several worlds).
for (const seed of ["n1", "n2", "n3"]) {
  const report = run({ edge: false, seed });
  const random = report.baselines.random_entry;
  assert.ok(random.n >= MIN_ENTRIES && random.distinct_days >= MIN_DISTINCT_DAYS, `fixture ${seed} has enough data (${random.n}, ${random.distinct_days})`);
  assert.equal(random.verdict, "NO SIGNIFICANT DIFFERENCE (95% CI includes 0)", `edge-free ${seed}: ${JSON.stringify(random.excess_ci95)}`);
  assert.ok(random.excess_ci95[0] < 0 && random.excess_ci95[1] > 0);
  assert.ok(random.p_value_one_sided > 0.025);
  assert.equal(random.draws, 1000);
}

// 4. Planted edge: significant excess over random entries and over equal weight.
for (const seed of ["e1", "e2", "e3"]) {
  const report = run({ edge: true, seed });
  const random = report.baselines.random_entry;
  assert.equal(random.verdict, "OUTPERFORMS (95% CI above 0)", `edge ${seed}: ${JSON.stringify(random.excess_ci95)}`);
  assert.ok(random.excess_ci95[0] > 0);
  assert.ok(random.p_value_one_sided < 0.01);
  assert.equal(report.baselines.equal_weight_approved.verdict, "OUTPERFORMS (95% CI above 0)");
}

// 5. INSUFFICIENT DATA below 100 entries / 30 distinct days, with the shortfall.
{
  const report = run({ edge: true, seed: "short", days: 12 });
  for (const key of ["buy_and_hold_eth", "equal_weight_approved", "random_entry"]) {
    const b = report.baselines[key];
    assert.equal(b.verdict, "INSUFFICIENT DATA", key);
    assert.ok(b.shortfall.entries_short > 0 && b.shortfall.days_short > 0);
    assert.equal(b.shortfall.entries_needed, 100);
    assert.equal(b.shortfall.days_needed, 30);
  }
  const text = formatReport(report);
  assert.match(text, /verdict: INSUFFICIENT DATA \(entries \d+\/100, short \d+; distinct days \d+\/30, short \d+\)/);
  assert.ok(!/OUTPERFORMS|UNDERPERFORMS/.test(text), "no verdict is printed below the minimums");
  // Empty inputs (no logs) are also INSUFFICIENT, never an error.
  const empty = compareBaselines({}, { seed: 1 });
  assert.equal(empty.baselines.random_entry.verdict, "INSUFFICIENT DATA");
  assert.equal(empty.system.n, 0);
}

// 6. Determinism with a seed.
{
  const a = JSON.stringify(run({ edge: false, seed: "det" }, { seed: 99 }));
  const b = JSON.stringify(run({ edge: false, seed: "det" }, { seed: 99 }));
  assert.equal(a, b, "same seed, same report");
  const c = run({ edge: false, seed: "det" }, { seed: 100 });
  assert.notDeepEqual(c.baselines.random_entry.excess_ci95, JSON.parse(a).baselines.random_entry.excess_ci95, "different seed, different draws");
  assert.equal(c.baselines.random_entry.excess_mean, JSON.parse(a).baselines.random_entry.excess_mean, "point estimate does not depend on the seed");
}

// 7. Window filter and trend-sleeve exclusion.
{
  const f = buildEvalFixture({ edge: false, seed: "win" });
  const closed = buildClosedPositions(f.tradeEvents);
  const firstHalf = compareBaselines({ snapshotRecords: f.snapshotRecords, settingsLedgerRecords: f.settingsLedgerRecords, closedPositions: closed }, { seed: 1, draws: 50, to: "2026-01-31T00:00:00Z" });
  assert.equal(firstHalf.system.n, closed.filter((t) => t.entry_ms <= Date.parse("2026-01-31T00:00:00Z")).length);
  const weth = { ...closed[0], position_id: "weth", contract_address: f.wethAddress };
  const withWeth = compareBaselines({ snapshotRecords: f.snapshotRecords, closedPositions: [...closed, weth] }, { seed: 1, draws: 50 });
  assert.equal(withWeth.system.n, closed.length, "trend-sleeve WETH trades are excluded by default");
}

console.log("verifyBaselineCompare: ok");
