import assert from "assert/strict";
import fs from "fs";

const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = () => {};

const {
  SETTINGS_DEFAULTS,
  buildPaperFillExecution,
  executeSell,
  openPosition
} = await import("../pipeline.js");

function buildPortfolio(overrides = {}) {
  return {
    cash_usd: overrides.cash_usd ?? 1000,
    positions: overrides.positions ?? {},
    closed_trades: overrides.closed_trades ?? [],
    action_history: overrides.action_history ?? [],
    cooldowns: overrides.cooldowns ?? {},
    stats: overrides.stats ?? {},
    settings: {
      ...SETTINGS_DEFAULTS,
      min_trade_usd: 1,
      ...(overrides.settings || {})
    }
  };
}

try {
  const entryExecution = buildPaperFillExecution({
    side: "buy",
    price: 1,
    cost_usd: 100,
    execution_data: {
      estimated_slippage_bps: 50
    },
    settings: SETTINGS_DEFAULTS
  });

  assert.equal(entryExecution.fill_price, 1.005);
  assert.equal(entryExecution.fee_bps, 12.5);
  assert.equal(Number(entryExecution.fee_usd.toFixed(3)), 0.125);

  const exitExecution = buildPaperFillExecution({
    side: "sell",
    price: 1,
    quantity: 100,
    settings: SETTINGS_DEFAULTS
  });

  assert.equal(exitExecution.fill_price, 0.9925);
  assert.equal(exitExecution.slippage_bps, 75);

  const portfolio = buildPortfolio();
  const candidate = {
    token: {
      symbol: "ASTRO",
      contract_address: "0x123",
      category: "meme"
    },
    market_data: {
      current_price: 1
    },
    liquidity_data: {
      liquidity_usd: 1000000
    },
    execution_data: {
      estimated_slippage_bps: 50
    },
    targets: {
      target_1: 1.2,
      target_2: 1.4,
      target_3: 1.6
    },
    invalidation_price: 0.9
  };

  const buyTrade = openPosition(portfolio, candidate, 100, "buy");
  assert.ok(buyTrade);
  assert.equal(buyTrade.quoted_price, 1);
  assert.equal(buyTrade.fill_price, 1.005);
  assert.equal(Number(buyTrade.cash_debit_usd.toFixed(3)), 100.125);
  assert.equal(Number(portfolio.cash_usd.toFixed(3)), 899.875);
  assert.equal(buyTrade.slippage_bps_applied, 50);
  assert.equal(buyTrade.fee_bps_applied, 12.5);
  assert.ok(portfolio.positions.ASTRO);

  portfolio.positions.ASTRO.current_price = 1;
  portfolio.positions.ASTRO.market_value_usd = portfolio.positions.ASTRO.quantity;
  portfolio.positions.ASTRO.last_market_snapshot = {
    execution_data: {
      estimated_slippage_bps: 50
    }
  };

  const sellTrade = executeSell(portfolio, {
    symbol: "ASTRO",
    fraction: 1,
    reason: "target_hit"
  });

  assert.ok(sellTrade);
  assert.equal(sellTrade.quoted_price, 1);
  assert.equal(sellTrade.fill_price, 0.995);
  assert.equal(sellTrade.fee_bps_applied, 12.5);
  assert.ok(sellTrade.pnl_usd < 0);
  assert.equal(portfolio.positions.ASTRO, undefined);

  console.log("verifyPaperExecutionRealism: ok");
} finally {
  fs.appendFileSync = originalAppendFileSync;
}
