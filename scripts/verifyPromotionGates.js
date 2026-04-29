import fs from "fs";
import os from "os";
import path from "path";
import { evaluatePromotionGates } from "./promotionGates.js";

const fixturePath = path.join(os.tmpdir(), `e3d-promotion-gate-fixture-${process.pid}.json`);

const fixture = {
  report_id: "fixture-backtest",
  report_type: "backtest_replay",
  schema_version: "1.0",
  generated_at: "2026-04-28T00:00:00.000Z",
  strategy_version: "fixture-strategy-v1",
  input_hash: "fixture-input-hash",
  determinism: {
    output_hash: "fixture-output-hash"
  },
  metrics: {
    initial_equity_usd: 100000,
    final_equity_usd: 100100,
    total_return_pct: 0.1,
    realized_pnl_usd: 100,
    unrealized_pnl_usd: 0,
    profit_factor: 2,
    max_drawdown_pct: 0.1,
    turnover_ratio: 0.01,
    fee_slippage_drag_usd: 4
  },
  baselines: {
    cash: { total_return_pct: 0 },
    buy_and_hold_eth: { available: false }
  },
  replay: {
    simulated_fills: [
      {
        ts: "2026-04-27T00:00:00.000Z",
        symbol: "AAA",
        replay_decision: "filled",
        fill: {
          realized_pnl_usd: 120,
          gross_notional_usd: 1000,
          fee_usd: 1,
          slippage_usd: 1
        }
      },
      {
        ts: "2026-04-27T01:00:00.000Z",
        symbol: "AAA",
        replay_decision: "filled",
        fill: {
          realized_pnl_usd: -20,
          gross_notional_usd: 1000,
          fee_usd: 1,
          slippage_usd: 1
        }
      }
    ]
  }
};

try {
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  const report = evaluatePromotionGates({
    backtestReport: fixturePath,
    targetState: "paper",
    appendEvent: false,
    writeReport: false,
    generatedAt: "2026-04-28T00:00:00.000Z"
  });

  if (report.promotion_allowed) {
    throw new Error("Expected under-sampled fixture promotion to be blocked.");
  }
  if (!report.signed || !report.signature) {
    throw new Error("Expected blocked promotion report to still be signed.");
  }
  if (!report.blockers.some((blocker) => blocker.code === "minimum_sample_size_not_met")) {
    throw new Error("Expected minimum sample size blocker.");
  }
  console.log(JSON.stringify({
    ok: true,
    checked: "promotion_gates_block_promoted_strategy_with_blockers",
    blocker_count: report.blockers.length,
    signed: report.signed
  }, null, 2));
} finally {
  try { fs.unlinkSync(fixturePath); } catch {}
}
