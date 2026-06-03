#!/usr/bin/env node
import assert from "assert";
import { buildSnapshotRow } from "./portfolioSnapshotWriter.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

// --- fixtures ---

const NOW_ISO = "2026-06-03T12:00:00.000Z";
const NOW_CH = "2026-06-03 12:00:00.000";

const basePortfolio = {
  cash_usd: 80000,
  positions: {
    TOKEN_A: { market_value_usd: 5000 },
    TOKEN_B: { market_value_usd: 3000 },
  },
  cooldowns: {},
  stats: {
    equity_usd: 88000,
    realized_pnl_usd: -5000,
    unrealized_pnl_usd: -7000,
  },
  settings: { paper_mode: true, initial_cash_usd: 100000 },
};

const macroWithPrices = { ethPrice: 3000, btcPrice: 60000 };
const stateWithBaseline = { initialEthPrice: 2500, initialBtcPrice: 50000 };
const stateEmpty = {};

// --- tests ---

test("uses stats.equity_usd when present", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.equityUsd, 88000);
});

test("falls back to cash + market value when stats.equity_usd absent", () => {
  const p = { ...basePortfolio, stats: {} };
  const row = buildSnapshotRow(p, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.cashUsd, 80000);
  assert.strictEqual(row.equityUsd, 88000); // 80000 + 5000 + 3000
});

test("totalPnlUsd = equity - 100000", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.totalPnlUsd, 88000 - 100000);
});

test("mode is PAPER when paper_mode true", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.mode, "PAPER");
});

test("mode is LIVE when paper_mode false", () => {
  const p = { ...basePortfolio, settings: { ...basePortfolio.settings, paper_mode: false } };
  const row = buildSnapshotRow(p, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.mode, "LIVE");
});

test("openPositionsCount matches positions object", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.openPositionsCount, 2);
});

test("blockedActionsCount reflects cooldowns", () => {
  const p = {
    ...basePortfolio,
    cooldowns: {
      "0xabc": { expires_at: "2026-06-04T00:00:00Z" },
      "0xdef": { expires_at: "2026-06-04T00:00:00Z" },
    },
  };
  const row = buildSnapshotRow(p, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.blockedActionsCount, 2);
});

test("benchmark ETH = (initialCash / initialEth) * currentEth", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  // (100000 / 2500) * 3000 = 120000
  assert.strictEqual(row.benchmarkEthValueUsd, 120000);
});

test("benchmark BTC = (initialCash / initialBtc) * currentBtc", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  // (100000 / 50000) * 60000 = 120000
  assert.strictEqual(row.benchmarkBtcValueUsd, 120000);
});

test("benchmark values are 0 when state has no baseline prices", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateEmpty, NOW_ISO);
  assert.strictEqual(row.benchmarkEthValueUsd, 0);
  assert.strictEqual(row.benchmarkBtcValueUsd, 0);
});

test("benchmark values are 0 when macro prices unavailable", () => {
  const row = buildSnapshotRow(basePortfolio, { ethPrice: 0, btcPrice: 0 }, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.benchmarkEthValueUsd, 0);
  assert.strictEqual(row.benchmarkBtcValueUsd, 0);
});

test("snapshotTime is ClickHouse-formatted UTC string", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.snapshotTime, NOW_CH);
  assert.strictEqual(row.createdAt, NOW_CH);
});

test("portfolioId is 'default'", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.portfolioId, "default");
});

test("benchmarkCustomValueUsd is always 0", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.benchmarkCustomValueUsd, 0);
});

test("realized and unrealized PnL pass through from stats", () => {
  const row = buildSnapshotRow(basePortfolio, macroWithPrices, stateWithBaseline, NOW_ISO);
  assert.strictEqual(row.realizedPnlUsd, -5000);
  assert.strictEqual(row.unrealizedPnlUsd, -7000);
});

test("handles missing stats gracefully (zeros)", () => {
  const p = { cash_usd: 90000, positions: {}, cooldowns: {}, settings: {} };
  const row = buildSnapshotRow(p, { ethPrice: 0, btcPrice: 0 }, stateEmpty, NOW_ISO);
  assert.strictEqual(row.realizedPnlUsd, 0);
  assert.strictEqual(row.unrealizedPnlUsd, 0);
  assert.strictEqual(row.openPositionsCount, 0);
});

// --- summary ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
