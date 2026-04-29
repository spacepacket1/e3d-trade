import fs from "fs";
import os from "os";
import path from "path";
import { generateOperationsMonitorReport } from "./operationsMonitor.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e3d-ops-monitor-"));
const logsDir = path.join(fixtureRoot, "logs");
const reportsDir = path.join(fixtureRoot, "reports");
const backtestsDir = path.join(reportsDir, "backtests");
const promotionsDir = path.join(reportsDir, "promotions");
const attributionDir = path.join(reportsDir, "attribution");
const incidentsDir = path.join(reportsDir, "incidents");

fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(backtestsDir, { recursive: true });
fs.mkdirSync(promotionsDir, { recursive: true });
fs.mkdirSync(attributionDir, { recursive: true });
fs.mkdirSync(incidentsDir, { recursive: true });

const portfolioFile = path.join(fixtureRoot, "portfolio.json");
const pipelineLog = path.join(logsDir, "pipeline.jsonl");
const trainingEventLog = path.join(logsDir, "training-events.jsonl");
const pipelinePidFile = path.join(logsDir, "pipeline.pid");
const dashboardHeartbeatFile = path.join(logsDir, "dashboard-heartbeat.json");
const operationsAlertLog = path.join(logsDir, "operations-alerts.jsonl");

const generatedAt = "2026-04-28T12:00:00.000Z";

const portfolio = {
  cash_usd: 85000,
  positions: {
    SOL: {
      symbol: "SOL",
      contract_address: "0xsol",
      category: "layer1",
      strategy_version: "paper-pipeline-v1",
      market_value_usd: 10000
    }
  },
  closed_trades: [
    {
      trade_id: "loss-1",
      ts: "2026-04-28T09:00:00.000Z",
      side: "sell",
      symbol: "ETH",
      pnl_usd: -3500
    }
  ],
  action_history: [
    {
      trade_id: "trade-1",
      ts: "2026-04-28T10:00:00.000Z",
      side: "buy",
      symbol: "SOL",
      order_lifecycle: {
        order_id: "ord_fixture_1",
        current_state: "submitted",
        state_history: [
          { state: "planned", ts: "2026-04-28T10:00:00.000Z" },
          { state: "submitted", ts: "2026-04-28T10:00:05.000Z" }
        ]
      }
    }
  ],
  settings: {
    paper_mode: true,
    risk_engine: {
      daily_realized_loss_limit_usd: 2500,
      daily_equity_drawdown_limit_pct: 0.05
    }
  },
  stats: {
    realized_pnl_usd: -3500,
    unrealized_pnl_usd: -500,
    equity_usd: 95000,
    peak_equity_usd: 110000,
    max_drawdown_pct: 0.136364,
    market_regime: "neutral"
  }
};

const performanceReport = {
  report_id: "performance-daily-20260428",
  report_type: "daily_performance",
  report_date: "20260428",
  generated_at: "2026-04-28T11:50:00.000Z",
  report_file: "reports/performance-daily-20260428.json",
  market_data_quality: {
    snapshot_count: 4,
    degraded_count: 1,
    stale_count: 1,
    blocker_count: 1,
    warning_count: 1,
    average_confidence: 0.72
  }
};

const backtestReport = {
  report_id: "backtest-fixture",
  report_type: "backtest_replay",
  generated_at: "2026-04-27T00:00:00.000Z",
  report_file: "reports/backtests/backtest-20260427-000000.json",
  safety: {
    portfolio_json_mutated: false
  }
};

const promotionReport = {
  report_id: "promotion-fixture",
  report_type: "strategy_promotion_gate",
  generated_at: "2026-04-28T11:40:00.000Z",
  report_file: "reports/promotions/promotion-20260428-114000.json",
  promotion_allowed: false,
  promotion_decision: "blocked",
  blockers: [
    { code: "minimum_sample_size_not_met", detail: "Need more out-of-sample trades." }
  ]
};

const attributionReport = {
  report_id: "attribution-fixture",
  report_type: "signal_attribution_expectancy",
  generated_at: "2026-04-28T11:30:00.000Z",
  report_file: "reports/attribution/signal-attribution-20260428-113000.json",
  safety: {
    portfolio_json_mutated: false
  }
};

const trainingEvents = [
  {
    ts: "2026-04-28T11:45:00.000Z",
    event_type: "cycle_end",
    cycle_id: "cycle-1"
  },
  {
    ts: "2026-04-28T11:46:00.000Z",
    event_type: "risk_engine_decision",
    payload: {
      risk_decision: {
        risk_decision_id: "rsk_fixture",
        side: "buy",
        decision: "block",
        blockers: ["negative_expectancy_regime"],
        policy_version: "risk-policy-v1"
      }
    }
  }
];

const pipelineRows = [
  { ts: "2026-04-28T11:55:00.000Z", stage: "heartbeat", data: { ok: true } }
];

try {
  fs.writeFileSync(portfolioFile, `${JSON.stringify(portfolio, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(reportsDir, "performance-daily-20260428.json"), `${JSON.stringify(performanceReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(backtestsDir, "backtest-20260427-000000.json"), `${JSON.stringify(backtestReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(promotionsDir, "promotion-20260428-114000.json"), `${JSON.stringify(promotionReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(attributionDir, "signal-attribution-20260428-113000.json"), `${JSON.stringify(attributionReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(trainingEventLog, `${trainingEvents.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(pipelineLog, `${pipelineRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(pipelinePidFile, `${process.pid}\n`, "utf8");
  fs.writeFileSync(dashboardHeartbeatFile, `${JSON.stringify({
    updated_at: "2026-04-28T11:59:30.000Z",
    pid: process.pid,
    host: "127.0.0.1",
    port: 3000
  }, null, 2)}\n`, "utf8");

  const report = generateOperationsMonitorReport({
    generatedAt,
    writeReport: false,
    writeEvents: true,
    portfolioFile,
    pipelineLog,
    trainingEventLog,
    pipelinePidFile,
    dashboardHeartbeatFile,
    operationsAlertLog,
    reportsDir,
    backtestReportsDir: backtestsDir,
    promotionReportsDir: promotionsDir,
    attributionReportsDir: attributionDir,
    incidentsDir,
    authStatus: {
      ok: true,
      connected: false,
      mode: null,
      updatedAt: null,
      lastError: null
    }
  });

  if (report.overall_status !== "degraded") {
    throw new Error(`Expected degraded status, got ${report.overall_status}`);
  }
  if (!report.alerts.active.some((alert) => alert.code === "daily_loss_limit_breached")) {
    throw new Error("Expected daily loss alert.");
  }
  if (!report.alerts.active.some((alert) => alert.code === "order_stuck")) {
    throw new Error("Expected order stuck alert.");
  }
  if (!report.alerts.active.some((alert) => alert.code === "new_buy_block_activated")) {
    throw new Error("Expected new buy block alert.");
  }
  if (report.health.pipeline.status !== "healthy") {
    throw new Error(`Expected healthy pipeline status, got ${report.health.pipeline.status}`);
  }
  if (report.health.dashboard.status !== "healthy") {
    throw new Error(`Expected healthy dashboard status, got ${report.health.dashboard.status}`);
  }
  if (!fs.existsSync(operationsAlertLog)) {
    throw new Error("Expected operations alert log to be written.");
  }

  console.log(JSON.stringify({
    ok: true,
    checked: "operations_monitor_alerts_and_health_summary",
    alert_count: report.alerts.active_count,
    incident_count: report.incidents.active_count,
    overall_status: report.overall_status
  }, null, 2));
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
