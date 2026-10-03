#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { classifyExitCohort, runProfitTakeCalibration } from "./profitTakeCalibration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
const installScript = path.join(repoRoot, "scripts", "installProfitTakeCalibrationCron.sh");
const H24_MS = 86400000;
const H48_MS = 172800000;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}: ${error.message}`);
    failed++;
  }
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profit-take-calibration-"));
  return {
    root,
    portfolioPath: path.join(root, "portfolio.json"),
    ledgerPath: path.join(root, "logs", "profit-take-calibration.jsonl"),
    reportsDir: path.join(root, "reports", "profit-take-calibration")
  };
}

function writePortfolio(portfolioPath, closedTrades) {
  fs.writeFileSync(portfolioPath, JSON.stringify({ closed_trades: closedTrades }, null, 2) + "\n");
}

function readLedgerLines(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
}

function readLedgerObjects(ledgerPath) {
  return readLedgerLines(ledgerPath).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
}

function readLatestSnapshot(ledgerPath, tradeId) {
  const snapshots = readLedgerObjects(ledgerPath).filter((entry) => entry.trade_id === tradeId);
  return snapshots[snapshots.length - 1] || null;
}

function readReports(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      body: JSON.parse(fs.readFileSync(path.join(reportsDir, name), "utf8"))
    }));
}

function baseTrade(overrides = {}) {
  return {
    trade_id: "trade-1",
    symbol: "AAA",
    contract_address: "0xaaa",
    side: "sell",
    reason: "stop_loss",
    ts: "2026-01-02T00:00:00.000Z",
    quantity: 2,
    price: 10,
    fill_price: 11,
    pnl_usd: 8,
    cost_portion_usd: 14,
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    trade_id: "snap-1",
    symbol: "SYM",
    contract_address: "0xsnap",
    exit_reason: "stop_loss",
    exit_cohort: "stop_loss",
    exit_ts: "2026-01-01T00:00:00.000Z",
    exit_price: 10,
    quantity: 1,
    pnl_usd: 5,
    cost_basis_usd: 4,
    hold_price_24h: null,
    hold_price_48h: null,
    beat_hold_24h: null,
    beat_hold_48h: null,
    recorded_at: "2026-01-03T00:00:00.000Z",
    ...overrides
  };
}

function runWith(options) {
  return runProfitTakeCalibration(options);
}

test("classifies included and excluded exit reasons exactly", () => {
  assert.equal(classifyExitCohort("stop_loss"), "stop_loss");
  assert.equal(classifyExitCohort("target_1"), "target_hit");
  assert.equal(classifyExitCohort("target_2"), "target_hit");
  assert.equal(classifyExitCohort("target_3"), "target_hit");
  assert.equal(classifyExitCohort("manual_operator"), "manual_action");
  assert.equal(classifyExitCohort("manual_operator_action"), "manual_action");

  for (const reason of [
    "stop",
    "STOP_LOSS",
    "target_4",
    "manual",
    "Manual_operator_action",
    "stub_flatten",
    "fraud_risk_breach",
    "non_tradeable_force_exit"
  ]) {
    assert.equal(classifyExitCohort(reason), null);
  }
});

test("initial ingestion is normalized, older-than-48h fetches once, and duplicate rows or reruns do not add another initial snapshot", () => {
  const fixture = makeFixture();
  const nowMs = Date.parse("2026-01-04T01:00:00.000Z");
  const portfolioBytes = [];
  const trade = baseTrade({
    trade_id: "dup-trade",
    reason: "target_1",
    ts: "2026-01-02T00:00:00.000Z",
    price: "bad-price",
    fill_price: 11,
    cost_basis_usd: undefined,
    cost_portion_usd: 14
  });
  writePortfolio(fixture.portfolioPath, [trade, { ...trade, symbol: "DIFF" }]);
  const originalPortfolioBytes = fs.readFileSync(fixture.portfolioPath);
  const fetchCalls = [];

  const guardedFs = {
    writeFileSync: fs.writeFileSync,
    appendFileSync: fs.appendFileSync,
    renameSync: fs.renameSync,
    truncateSync: fs.truncateSync
  };

  const guardPath = (target) => {
    if (path.resolve(String(target)) === path.resolve(fixture.portfolioPath)) {
      throw new Error("portfolio write attempted");
    }
  };

  fs.writeFileSync = function patchedWriteFileSync(target, ...args) {
    guardPath(target);
    return guardedFs.writeFileSync.call(this, target, ...args);
  };
  fs.appendFileSync = function patchedAppendFileSync(target, ...args) {
    guardPath(target);
    return guardedFs.appendFileSync.call(this, target, ...args);
  };
  fs.renameSync = function patchedRenameSync(target, ...args) {
    guardPath(target);
    return guardedFs.renameSync.call(this, target, ...args);
  };
  fs.truncateSync = function patchedTruncateSync(target, ...args) {
    guardPath(target);
    return guardedFs.truncateSync.call(this, target, ...args);
  };

  try {
    // This trade is already more than 48h old on its very first ingestion -- both
    // horizons are due at once. One fetch is made and that same observed price is
    // written onto every due horizon in this one ledger line.
    const first = runWith({
      portfolioPath: fixture.portfolioPath,
      ledgerPath: fixture.ledgerPath,
      reportsDir: fixture.reportsDir,
      now: () => nowMs,
      fetchPrice: (address) => {
        fetchCalls.push(address);
        return 11;
      }
    });
    assert.equal(first.appendedCount, 1);
    assert.equal(fetchCalls.length, 1);

    const linesAfterFirst = readLedgerLines(fixture.ledgerPath);
    assert.equal(linesAfterFirst.length, 1);
    const saved = JSON.parse(linesAfterFirst[0]);
    assert.equal(saved.exit_reason, "target_1");
    assert.equal(saved.exit_cohort, "target_hit");
    assert.equal(saved.exit_ts, "2026-01-02T00:00:00.000Z");
    assert.equal(saved.exit_price, 11);
    assert.equal(saved.cost_basis_usd, 14);
    assert.equal(saved.hold_price_24h, 11);
    assert.equal(saved.hold_price_48h, 11);
    assert.equal(saved.beat_hold_24h, false);
    assert.equal(saved.beat_hold_48h, false);

    // Both horizons are already resolved -- a later run must be a true no-op.
    const second = runWith({
      portfolioPath: fixture.portfolioPath,
      ledgerPath: fixture.ledgerPath,
      reportsDir: fixture.reportsDir,
      now: () => nowMs + 60000,
      fetchPrice: () => {
        throw new Error("should not fetch once both horizons are resolved");
      }
    });
    assert.equal(second.appendedCount, 0);
    assert.equal(readLedgerLines(fixture.ledgerPath).length, 1);
  } finally {
    fs.writeFileSync = guardedFs.writeFileSync;
    fs.appendFileSync = guardedFs.appendFileSync;
    fs.renameSync = guardedFs.renameSync;
    fs.truncateSync = guardedFs.truncateSync;
  }

  portfolioBytes.push(fs.readFileSync(fixture.portfolioPath));
  assert.deepEqual(portfolioBytes[0], originalPortfolioBytes);
});

test("an explicit null cost_basis_usd falls back to cost_portion_usd instead of becoming zero, and a null/blank pnl_usd is rejected rather than accepted as zero", () => {
  const fixture = makeFixture();
  const nowMs = Date.parse("2026-01-04T01:00:00.000Z");
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "null-cost-basis",
      reason: "stop_loss",
      cost_basis_usd: null,
      cost_portion_usd: 22
    }),
    baseTrade({
      trade_id: "null-pnl",
      symbol: "BBB",
      contract_address: "0xbbb",
      reason: "stop_loss",
      pnl_usd: null
    }),
    baseTrade({
      trade_id: "blank-pnl",
      symbol: "CCC",
      contract_address: "0xccc",
      reason: "stop_loss",
      pnl_usd: ""
    })
  ]);

  const result = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => nowMs,
    fetchPrice: () => 11
  });

  assert.equal(result.appendedCount, 1, "only the valid trade should be ingested");
  const ledgerRows = readLedgerObjects(fixture.ledgerPath);
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].trade_id, "null-cost-basis");
  assert.equal(ledgerRows[0].cost_basis_usd, 22, "a null cost_basis_usd must fall back to cost_portion_usd, not become 0");
});

test("a trade younger than 24 hours appends once without fetching and a no-op rerun preserves ledger bytes and report output", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "young-trade",
      reason: "manual_operator_action",
      ts: "2026-01-03T02:00:00.000Z"
    })
  ]);

  let fetchCount = 0;
  const first = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-04T00:00:00.000Z"),
    fetchPrice: () => {
      fetchCount++;
      return 12;
    }
  });
  assert.equal(first.appendedCount, 1);
  assert.equal(fetchCount, 0);
  assert.equal(readLedgerLines(fixture.ledgerPath).length, 1);
  assert.equal(readReports(fixture.reportsDir).length, 1);

  const ledgerBefore = fs.readFileSync(fixture.ledgerPath);
  const reportNamesBefore = readReports(fixture.reportsDir).map((entry) => entry.name).join(",");
  const second = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-04T00:05:00.000Z"),
    fetchPrice: () => {
      fetchCount++;
      return 12;
    }
  });
  assert.equal(second.appendedCount, 0);
  assert.equal(fetchCount, 0);
  assert.deepEqual(fs.readFileSync(fixture.ledgerPath), ledgerBefore);
  assert.equal(readReports(fixture.reportsDir).map((entry) => entry.name).join(","), reportNamesBefore);
});

test("an existing 24-hour observation is not fetched again before 48 hours, and crossing 48 hours fills only the missing 48-hour fields", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [baseTrade({ trade_id: "carry-trade", ts: "2026-01-01T00:00:00.000Z" })]);

  const initial = snapshot({
    trade_id: "carry-trade",
    contract_address: "0xcarry",
    exit_reason: "manual_operator_action",
    exit_cohort: "manual_action",
    exit_ts: "2026-01-02T00:00:00.000Z",
    hold_price_24h: 7,
    hold_price_48h: null,
    beat_hold_24h: false,
    beat_hold_48h: null
  });
  fs.mkdirSync(path.dirname(fixture.ledgerPath), { recursive: true });
  fs.writeFileSync(fixture.ledgerPath, JSON.stringify(initial) + "\n");

  let fetchCount = 0;
  const before48 = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-03T06:00:00.000Z"),
    fetchPrice: () => {
      fetchCount++;
      return 10;
    }
  });
  assert.equal(before48.appendedCount, 0);
  assert.equal(fetchCount, 0);
  assert.equal(readLedgerLines(fixture.ledgerPath).length, 1);

  const after48 = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-04T00:00:00.000Z"),
    fetchPrice: () => {
      fetchCount++;
      return 10;
    }
  });
  assert.equal(after48.appendedCount, 1);
  assert.equal(fetchCount, 1);
  assert.equal(readLedgerLines(fixture.ledgerPath).length, 2);
  const latest = readLatestSnapshot(fixture.ledgerPath, "carry-trade");
  assert.equal(latest.hold_price_24h, 7);
  assert.equal(latest.beat_hold_24h, false);
  assert.equal(latest.hold_price_48h, 10);
  assert.equal(latest.beat_hold_48h, false);
  assert.equal(latest.exit_reason, "manual_operator_action");
});

test("failed eligible fetches leave null horizons and malformed ledger rows do not prevent a later retry from filling them", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "retry-trade",
      contract_address: "0xretry",
      reason: "target_2",
      ts: "2026-01-02T12:00:00.000Z",
      fill_price: undefined,
      price: 13
    })
  ]);

  const first = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-03T18:00:00.000Z"),
    fetchPrice: () => null
  });
  assert.equal(first.appendedCount, 1);
  const firstSnapshot = readLatestSnapshot(fixture.ledgerPath, "retry-trade");
  assert.equal(firstSnapshot.hold_price_24h, null);
  assert.equal(firstSnapshot.hold_price_48h, null);

  const originalLedger = fs.readFileSync(fixture.ledgerPath, "utf8");
  fs.writeFileSync(fixture.ledgerPath, `${originalLedger}not-json\n`);

  const second = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-03T19:00:00.000Z"),
    fetchPrice: () => 15
  });
  assert.equal(second.appendedCount, 1);
  const latest = readLatestSnapshot(fixture.ledgerPath, "retry-trade");
  assert.equal(latest.hold_price_24h, 15);
  assert.equal(latest.hold_price_48h, null);
  assert.equal(latest.beat_hold_24h, false);
  assert.equal(readLedgerLines(fixture.ledgerPath).length, 3);
});

test("a syntactically valid but incomplete ledger row (just a trade_id) does not supersede a fully-populated prior snapshot", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "shape-trade",
      contract_address: "0xshape",
      reason: "stop_loss",
      ts: "2026-01-02T00:00:00.000Z"
    })
  ]);

  const first = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-03T01:00:00.000Z"),
    fetchPrice: () => 11
  });
  assert.equal(first.appendedCount, 1);
  const fullSnapshot = readLatestSnapshot(fixture.ledgerPath, "shape-trade");
  assert.equal(fullSnapshot.hold_price_24h, 11);

  // A truncated or hand-edited line that still parses as JSON and still has a
  // trade_id, but is missing every other required field.
  const originalLedger = fs.readFileSync(fixture.ledgerPath, "utf8");
  fs.writeFileSync(fixture.ledgerPath, `${originalLedger}${JSON.stringify({ trade_id: "shape-trade" })}\n`);

  // Only ~25h have elapsed -- 48h isn't due yet. If the incomplete row were wrongly
  // treated as the current state (hold_price_24h reading as undefined/null), 24h would
  // look outstanding again and this would incorrectly refetch.
  const second = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-03T01:01:00.000Z"),
    fetchPrice: () => {
      throw new Error("should not refetch 24h -- the incomplete row must not have erased it");
    }
  });
  assert.equal(second.appendedCount, 0, "the incomplete row must be ignored, not treated as the current state");
});

test("a failed fetch when multiple horizons are due leaves every horizon null, fully retryable next run", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "retry-multi",
      contract_address: "0xretrymulti",
      reason: "stop_loss",
      ts: "2026-01-02T00:00:00.000Z"
    })
  ]);

  const nowMs = Date.parse("2026-01-04T01:00:00.000Z");
  const first = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => nowMs,
    fetchPrice: () => null
  });
  assert.equal(first.appendedCount, 1);
  let saved = readLatestSnapshot(fixture.ledgerPath, "retry-multi");
  assert.equal(saved.hold_price_24h, null);
  assert.equal(saved.hold_price_48h, null);

  const second = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => nowMs + 60000,
    fetchPrice: () => 17
  });
  assert.equal(second.appendedCount, 1);
  saved = readLatestSnapshot(fixture.ledgerPath, "retry-multi");
  assert.equal(saved.hold_price_24h, 17);
  assert.equal(saved.hold_price_48h, 17);
});

test("report metrics use strict beat-hold comparisons, full current state, even and odd medians, and null metrics for empty horizons", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "new-target",
      contract_address: "0xnew",
      reason: "target_3",
      ts: "2026-01-04T11:00:00.000Z",
      pnl_usd: 1,
      fill_price: 9,
      cost_portion_usd: 8
    })
  ]);

  const seeded = [
    snapshot({
      trade_id: "stop-a",
      contract_address: "0x1",
      exit_cohort: "stop_loss",
      pnl_usd: 8,
      cost_basis_usd: 5,
      hold_price_24h: 2,
      hold_price_48h: 4,
      beat_hold_24h: true,
      beat_hold_48h: true
    }),
    snapshot({
      trade_id: "stop-b",
      contract_address: "0x2",
      exit_cohort: "stop_loss",
      pnl_usd: 1,
      cost_basis_usd: 5,
      hold_price_24h: 4,
      hold_price_48h: 6,
      beat_hold_24h: false,
      beat_hold_48h: false
    }),
    snapshot({
      trade_id: "manual-a",
      contract_address: "0x3",
      exit_reason: "manual_operator_action",
      exit_cohort: "manual_action",
      pnl_usd: 5,
      cost_basis_usd: 4,
      hold_price_24h: 9,
      hold_price_48h: 9,
      beat_hold_24h: false,
      beat_hold_48h: false
    })
  ];

  fs.mkdirSync(path.dirname(fixture.ledgerPath), { recursive: true });
  fs.writeFileSync(fixture.ledgerPath, seeded.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const result = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-04T12:00:00.000Z"),
    fetchPrice: () => {
      throw new Error("should not fetch");
    }
  });
  assert.equal(result.appendedCount, 1);

  const reports = readReports(fixture.reportsDir);
  assert.equal(reports.length, 1);
  const report = reports[0].body;
  assert.equal(report.trade_count, 4);
  assert.equal(report.with_24h_count, 3);
  assert.equal(report.with_48h_count, 3);
  assert.equal(report.with_both_count, 3);
  assert.equal(report.cohorts.stop_loss.trade_count, 2);
  assert.equal(report.cohorts.stop_loss.with_both_count, 2);
  assert.equal(report.cohorts.stop_loss.h24.evaluated_count, 2);
  assert.equal(report.cohorts.stop_loss.h24.beat_hold_count, 1);
  assert.equal(report.cohorts.stop_loss.h24.beat_hold_rate_pct, 50);
  assert.equal(report.cohorts.stop_loss.h24.average_delta_usd, 6.5);
  assert.equal(report.cohorts.stop_loss.h24.median_delta_usd, 6.5);
  assert.equal(report.cohorts.stop_loss.h48.average_delta_usd, 4.5);
  assert.equal(report.cohorts.stop_loss.h48.median_delta_usd, 4.5);
  assert.equal(report.cohorts.manual_action.h24.evaluated_count, 1);
  assert.equal(report.cohorts.manual_action.h24.beat_hold_count, 0);
  assert.equal(report.cohorts.manual_action.h24.average_delta_usd, 0);
  assert.equal(report.cohorts.manual_action.h24.median_delta_usd, 0);
  assert.equal(report.cohorts.target_hit.trade_count, 1);
  assert.equal(report.cohorts.target_hit.h24.evaluated_count, 0);
  assert.equal(report.cohorts.target_hit.h24.beat_hold_rate_pct, null);
  assert.equal(report.cohorts.target_hit.h24.average_delta_usd, null);
  assert.equal(report.cohorts.target_hit.h24.median_delta_usd, null);
});

test("a later appended trade produces a report that includes both the earlier and later trades", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "first-trade",
      contract_address: "0xfirst",
      reason: "stop_loss",
      ts: "2026-01-01T00:00:00.000Z"
    })
  ]);

  runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-03T12:00:00.000Z"),
    fetchPrice: () => 7
  });

  writePortfolio(fixture.portfolioPath, [
    baseTrade({
      trade_id: "first-trade",
      contract_address: "0xfirst",
      reason: "stop_loss",
      ts: "2026-01-01T00:00:00.000Z"
    }),
    baseTrade({
      trade_id: "second-trade",
      contract_address: "0xsecond",
      reason: "manual_operator_action",
      ts: "2026-01-04T11:30:00.000Z"
    })
  ]);

  const result = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-04T12:00:00.000Z"),
    fetchPrice: () => 9
  });
  // Only 1 append this run: first-trade was already past both horizons on its very
  // first run, so both were marked permanently missed then and are never retried;
  // second-trade is newly discovered (not yet eligible for either horizon itself).
  assert.equal(result.appendedCount, 1);

  const reports = readReports(fixture.reportsDir);
  assert.equal(reports.length, 2);
  const latest = reports[1].body;
  assert.equal(latest.trade_count, 2);
  const latestTradeIds = new Set(readLedgerObjects(fixture.ledgerPath).map((entry) => entry.trade_id));
  assert(latestTradeIds.has("first-trade"));
  assert(latestTradeIds.has("second-trade"));
});

test("a pure no-op run with no new trade and no new horizon leaves missing outputs absent", () => {
  const fixture = makeFixture();
  writePortfolio(fixture.portfolioPath, []);

  const result = runWith({
    portfolioPath: fixture.portfolioPath,
    ledgerPath: fixture.ledgerPath,
    reportsDir: fixture.reportsDir,
    now: () => Date.parse("2026-01-04T12:00:00.000Z"),
    fetchPrice: () => {
      throw new Error("should not fetch");
    }
  });
  assert.equal(result.appendedCount, 0);
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
  assert.equal(fs.existsSync(fixture.reportsDir), false);
});

test("installer --print includes the calibration script path and does not invoke crontab", () => {
  const fixture = makeFixture();
  const fakeCrontabMarker = path.join(fixture.root, "crontab-invoked.txt");
  const fakeCrontabBin = path.join(fixture.root, "fake-crontab.sh");
  fs.writeFileSync(fakeCrontabBin, `#!/usr/bin/env bash
set -euo pipefail
echo invoked > "${fakeCrontabMarker}"
exit 1
`, { mode: 0o755 });

  const output = execFileSync("bash", [installScript, "--print"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PROFIT_TAKE_CALIBRATION_REPO_DIR: repoRoot,
      PROFIT_TAKE_CALIBRATION_NODE_BIN: process.execPath,
      PROFIT_TAKE_CALIBRATION_CRONTAB_BIN: fakeCrontabBin
    }
  }).trim();

  assert(output.startsWith("0 * * * * "));
  assert(output.includes("scripts/profitTakeCalibration.js"));
  assert.equal(fs.existsSync(fakeCrontabMarker), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
