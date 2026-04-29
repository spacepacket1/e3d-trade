import assert from "assert";
import { evaluateRiskDecision, buildRiskDecisionRef } from "./riskEngine.js";

function portfolioFixture() {
  return {
    cash_usd: 90000,
    positions: {
      ETH: {
        symbol: "ETH",
        contract_address: "0xeth",
        category: "layer1",
        strategy_version: "paper-pipeline-v1",
        market_value_usd: 10000
      }
    },
    action_history: [],
    closed_trades: [],
    settings: {
      max_position_pct: 0.10,
      category_cap_pct: 0.30,
      max_open_positions: 8,
      risk_engine: {
        daily_realized_loss_limit_usd: 1000,
        rolling_24h_loss_limit_usd: 1500,
        max_daily_turnover_usd: 50000,
        cooldown_after_stop_loss_hours: 12
      }
    },
    stats: {
      market_regime: "neutral"
    }
  };
}

const baseInput = {
  mode: "paper",
  enforcement_mode: "enforced",
  evaluated_at: "2026-04-28T12:00:00.000Z",
  analytics: {
    evaluated_at: "2026-04-28T12:00:00.000Z",
    market_regime: "neutral",
    day_start_equity_usd: 100000,
    review_stats: {
      setup_expectancy: []
    }
  },
  intent: {
    side: "buy",
    symbol: "SOL",
    contract_address: "0xsol",
    category: "layer1",
    strategy_version: "paper-pipeline-v1",
    setup_type: "breakout",
    requested_notional_usd: 5000,
    requested_quantity: 25,
    liquidity_usd: 500000,
    spread_bps: 20,
    slippage_bps: 30
  }
};

const one = evaluateRiskDecision({
  ...baseInput,
  portfolio: portfolioFixture()
});
const two = evaluateRiskDecision({
  ...baseInput,
  portfolio: portfolioFixture()
});

assert.equal(one.risk_decision_id, two.risk_decision_id, "risk decision id should be stable");
assert.equal(one.decision, "allow", "healthy buy should be allowed");
assert.equal(buildRiskDecisionRef(one)?.risk_decision_id, one.risk_decision_id, "ref should preserve id");

const lossBlocked = evaluateRiskDecision({
  ...baseInput,
  portfolio: {
    ...portfolioFixture(),
    closed_trades: [
      {
        ts: "2026-04-28T10:00:00.000Z",
        trade_id: "loss-1",
        side: "sell",
        symbol: "ETH",
        pnl_usd: -1250,
        proceeds_usd: 5000
      }
    ]
  }
});
assert.equal(lossBlocked.decision, "block", "daily loss breach should block buy");
assert(lossBlocked.blockers.includes("daily_realized_loss_limit"), "loss limit blocker missing");

const sellAllowed = evaluateRiskDecision({
  ...baseInput,
  portfolio: {
    ...portfolioFixture(),
    closed_trades: [
      {
        ts: "2026-04-28T10:00:00.000Z",
        trade_id: "loss-1",
        side: "sell",
        symbol: "ETH",
        pnl_usd: -2000,
        proceeds_usd: 5000
      }
    ]
  },
  intent: {
    ...baseInput.intent,
    side: "sell",
    requested_notional_usd: 5000
  }
});
assert.equal(sellAllowed.decision, "allow", "exits should remain available");

const cooldownBlocked = evaluateRiskDecision({
  ...baseInput,
  portfolio: {
    ...portfolioFixture(),
    closed_trades: [
      {
        ts: "2026-04-28T05:30:00.000Z",
        trade_id: "stop-1",
        side: "sell",
        symbol: "SOL",
        contract_address: "0xsol",
        pnl_usd: -400,
        proceeds_usd: 1200,
        reason: "stop_loss:paper_trade"
      }
    ]
  }
});
assert.equal(cooldownBlocked.decision, "block", "stop-loss cooldown should block re-entry");
assert(cooldownBlocked.blockers.includes("cooldown_after_stop_loss"), "stop-loss cooldown blocker missing");

console.log("verifyRiskEngine: ok");
