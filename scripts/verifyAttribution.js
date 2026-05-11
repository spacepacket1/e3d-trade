import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildAttributionReport } from "../server.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-attribution-"));
const pipelineLog = path.join(tmpDir, "pipeline.jsonl");
const trainingEventLog = path.join(tmpDir, "training-events.jsonl");

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

writeJsonl(trainingEventLog, [
  {
    ts: "2026-05-01T08:00:00.000Z",
    event_type: "trade",
    actor: "pipeline",
    position_id: "pos-1",
    payload: {
      position_id: "pos-1",
      trade: {
        side: "buy",
        trade_lifecycle: "open",
        paper_trade_ticket: { source_agent: "scout" },
        evidence_summary: {
          highlights: [
            { label: "breakout" }
          ]
        }
      }
    }
  },
  {
    ts: "2026-05-01T09:00:00.000Z",
    event_type: "trade",
    actor: "pipeline",
    position_id: "pos-2",
    payload: {
      position_id: "pos-2",
      trade: {
        side: "buy",
        trade_lifecycle: "open",
        paper_trade_ticket: { source_agent: "user_watchlist" },
        evidence_summary: {
          highlights: [
            { label: "mean_reversion" }
          ]
        }
      }
    }
  },
  {
    ts: "2026-05-01T10:00:00.000Z",
    event_type: "trade",
    actor: "pipeline",
    position_id: "pos-3",
    payload: {
      position_id: "pos-3",
      trade: {
        side: "buy",
        trade_lifecycle: "open",
        paper_trade_ticket: { source_agent: "scout" },
        evidence_summary: {
          highlights: [
            { label: "thesis" }
          ]
        }
      }
    }
  },
  {
    ts: "2026-05-01T12:00:00.000Z",
    event_type: "outcome",
    position_id: "pos-1",
    payload: {
      position_id: "pos-1",
      pnl_usd: 20,
      trade: {
        reason: "target_hit",
        cost_portion_usd: 200
      },
      position_before: {
        cost_basis_usd: 200,
        category: "meme",
        liquidity_usd: 1000000,
        flow_signal: "strong_accumulation",
        last_market_snapshot: {
          market_data: { market_cap_usd: 100000000 }
        }
      }
    }
  },
  {
    ts: "2026-05-01T13:00:00.000Z",
    event_type: "outcome",
    position_id: "pos-2",
    payload: {
      position_id: "pos-2",
      pnl_usd: -10,
      trade: {
        reason: "time_stop",
        cost_portion_usd: 200
      },
      position_before: {
        cost_basis_usd: 200,
        category: "other",
        liquidity_usd: 100000,
        flow_signal: "neutral",
        last_market_snapshot: {
          market_data: { market_cap_usd: 10000000 }
        }
      }
    }
  },
  {
    ts: "2026-05-01T14:00:00.000Z",
    event_type: "outcome",
    position_id: "pos-3",
    payload: {
      position_id: "pos-3",
      pnl_usd: -30,
      trade: {
        reason: "stop_loss",
        cost_portion_usd: 200
      },
      position_before: {
        cost_basis_usd: 200,
        category: "defi",
        liquidity_usd: 1000000,
        flow_signal: "distribution",
        last_market_snapshot: {
          market_data: { market_cap_usd: 100000000 }
        }
      }
    }
  }
]);

writeJsonl(pipelineLog, [
  {
    ts: "2026-04-20T10:00:00.000Z",
    stage: "risk_rejected",
    data: [
      {
        proposal: {
          token: { category: "legacy" },
          liquidity_data: { liquidity_usd: 100000 },
          market_data: { market_cap_usd: 10000000 },
          flow_signal: "neutral"
        },
        risk: {
          reason_codes: ["legacy_zero_rule"]
        }
      }
    ]
  },
  {
    ts: "2026-05-01T09:30:00.000Z",
    stage: "risk_rejected",
    data: [
      {
        proposal: {
          token: { category: "meme" },
          liquidity_data: { liquidity_usd: 1500000 },
          market_data: { market_cap_usd: 120000000 },
          flow_signal: "strong_accumulation"
        },
        risk: {
          reason_codes: ["confidence_too_low"]
        }
      }
    ]
  },
  {
    ts: "2026-05-01T11:00:00.000Z",
    stage: "harvest_rejected",
    data: [
      {
        proposal: {
          token: { category: "defi" },
          liquidity_data: { liquidity_usd: 1500000 },
          market_data: { market_cap_usd: 120000000 },
          narrative_data: { flow_direction: "distribution" }
        },
        risk: {
          reason_codes: ["bearish_order_flow"]
        }
      }
    ]
  }
]);

const report = await buildAttributionReport({
  window: "7d",
  pipelineLog,
  trainingEventLog,
  nowMs: Date.parse("2026-05-02T00:00:00.000Z")
});

assert.equal(report.window, "7d");
assert.equal(Array.isArray(report.by_rule), true);
assert.equal(Array.isArray(report.by_signal_source), true);
assert.equal(Array.isArray(report.by_story_type), true);
assert.equal(Array.isArray(report.by_exit_reason), true);

const ruleMap = new Map(report.by_rule.map((row) => [row.rule, row]));
assert.deepEqual(ruleMap.get("confidence_too_low"), {
  rule: "confidence_too_low",
  rejections: 1,
  matched_opened_trades: 1,
  avg_realized_pnl_pct: 10,
  verdict: "inconclusive"
});
assert.deepEqual(ruleMap.get("bearish_order_flow"), {
  rule: "bearish_order_flow",
  rejections: 1,
  matched_opened_trades: 1,
  avg_realized_pnl_pct: -15,
  verdict: "inconclusive"
});
assert.deepEqual(ruleMap.get("legacy_zero_rule"), {
  rule: "legacy_zero_rule",
  rejections: 0,
  matched_opened_trades: 0,
  avg_realized_pnl_pct: null,
  verdict: "inconclusive"
});

const signalSourceMap = new Map(report.by_signal_source.map((row) => [row.signal_source, row]));
assert.equal(signalSourceMap.get("scout")?.completed_trades, 2);
assert.equal(signalSourceMap.get("scout")?.avg_realized_pnl_pct, -2.5);

const storyTypeMap = new Map(report.by_story_type.map((row) => [row.story_type, row]));
assert.equal(storyTypeMap.get("breakout")?.avg_realized_pnl_pct, 10);
assert.equal(storyTypeMap.get("thesis")?.avg_realized_pnl_pct, -15);

const exitReasonMap = new Map(report.by_exit_reason.map((row) => [row.exit_reason, row]));
assert.equal(exitReasonMap.get("target_hit")?.completed_trades, 1);
assert.equal(exitReasonMap.get("stop_loss")?.avg_realized_pnl_pct, -15);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("verifyAttribution: ok");
