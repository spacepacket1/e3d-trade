import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getAuthStatus } from "../e3dAuthClient.js";
import { evaluateLiveCapabilityStatus } from "./custodyControls.js";
import { resolveRiskPolicy } from "./riskEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const LOG_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(ROOT, "reports");
const OPERATIONS_REPORT_DIR = path.join(REPORTS_DIR, "operations");
const INCIDENTS_DIR = path.join(REPORTS_DIR, "incidents");
const BACKTEST_REPORTS_DIR = path.join(REPORTS_DIR, "backtests");
const PROMOTION_REPORTS_DIR = path.join(REPORTS_DIR, "promotions");
const ATTRIBUTION_REPORTS_DIR = path.join(REPORTS_DIR, "attribution");
const RECONCILIATION_REPORTS_DIR = path.join(REPORTS_DIR, "reconciliation");

const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const PIPELINE_PID_FILE = path.join(LOG_DIR, "pipeline.pid");
const DASHBOARD_HEARTBEAT_FILE = path.join(LOG_DIR, "dashboard-heartbeat.json");
const OPERATIONS_ALERT_LOG = path.join(LOG_DIR, "operations-alerts.jsonl");

const DEFAULT_THRESHOLDS = Object.freeze({
  pipeline_heartbeat_max_age_ms: 20 * 60 * 1000,
  dashboard_heartbeat_max_age_ms: 2 * 60 * 1000,
  cycle_success_max_age_ms: 2 * 60 * 60 * 1000,
  order_stuck_max_age_ms: 60 * 60 * 1000,
  daily_performance_max_age_ms: 36 * 60 * 60 * 1000,
  backtest_max_age_ms: 14 * 24 * 60 * 60 * 1000,
  promotion_max_age_ms: 14 * 24 * 60 * 60 * 1000,
  attribution_max_age_ms: 14 * 24 * 60 * 60 * 1000,
  reconciliation_max_age_ms: 36 * 60 * 60 * 1000
});

const TERMINAL_ORDER_STATES = new Set([
  "risk_rejected",
  "filled",
  "canceled",
  "expired",
  "rejected",
  "failed"
]);

function nowIso() {
  return new Date().toISOString();
}

function formatReportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function pct(value) {
  return round(value * 100, 4);
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function localDayKey(ts, timezone = null) {
  const date = ts ? new Date(ts) : new Date();
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function extractTs(entry) {
  return entry?.ts || entry?.generated_at || entry?.updated_at || null;
}

function latestByTs(records = []) {
  return [...records]
    .filter(Boolean)
    .sort((a, b) => String(extractTs(b) || "").localeCompare(String(extractTs(a) || "")))[0] || null;
}

function listJsonReports(dirPath, matcher, expectedType = null) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter((name) => matcher.test(name))
      .map((name) => path.join(dirPath, name))
      .map((filePath) => ({ filePath, report: readJsonFile(filePath, null) }))
      .filter(({ report }) => report && (!expectedType || report.report_type === expectedType))
      .sort((a, b) => String(extractTs(b.report) || "").localeCompare(String(extractTs(a.report) || "")));
  } catch {
    return [];
  }
}

function latestPerformanceReport(options = {}) {
  const files = listJsonReports(options.reportsDir || REPORTS_DIR, /^performance-daily-\d{8}\.json$/, "daily_performance");
  return files[0] || null;
}

function latestBacktestReport(options = {}) {
  const files = listJsonReports(options.backtestReportsDir || BACKTEST_REPORTS_DIR, /^backtest-\d{8}-\d{6}\.json$/, "backtest_replay");
  return files[0] || null;
}

function latestPromotionReport(options = {}) {
  const files = listJsonReports(options.promotionReportsDir || PROMOTION_REPORTS_DIR, /^promotion-\d{8}-\d{6}\.json$/, "strategy_promotion_gate");
  return files[0] || null;
}

function latestAttributionReport(options = {}) {
  const files = listJsonReports(options.attributionReportsDir || ATTRIBUTION_REPORTS_DIR, /^signal-attribution-\d{8}-\d{6}\.json$/, "signal_attribution_expectancy");
  return files[0] || null;
}

function latestReconciliationReport(options = {}) {
  const files = listJsonReports(options.reconciliationReportsDir || RECONCILIATION_REPORTS_DIR, /^reconciliation-\d{8}-\d{6}\.json$/, "reconciliation_accounting");
  return files[0] || null;
}

function latestPipelineHeartbeat(records = []) {
  return [...records].reverse().find((entry) => entry?.ts) || null;
}

function latestSuccessfulCycle(events = []) {
  return [...events].reverse().find((entry) => entry?.event_type === "cycle_end" && entry?.ts) || null;
}

function latestRiskEngineDecision(events = []) {
  return [...events].reverse().find((entry) => entry?.event_type === "risk_engine_decision" && entry?.payload?.risk_decision) || null;
}

function latestStage(records = [], stage) {
  return [...records].reverse().find((entry) => entry?.stage === stage) || null;
}

function pipelineStatusSummary(pipelineLog, trainingEvents, generatedAtMs, thresholds, pidFile = PIPELINE_PID_FILE) {
  const pid = (() => {
    try {
      const value = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  })();
  const alive = isProcessAlive(pid);
  const heartbeat = latestPipelineHeartbeat(pipelineLog);
  const heartbeatMs = optionalMs(heartbeat?.ts);
  const lastCycle = latestSuccessfulCycle(trainingEvents);
  const lastCycleMs = optionalMs(lastCycle?.ts);
  const heartbeatAgeMs = heartbeatMs == null ? null : Math.max(0, generatedAtMs - heartbeatMs);
  const cycleAgeMs = lastCycleMs == null ? null : Math.max(0, generatedAtMs - lastCycleMs);
  const heartbeatStale = heartbeatAgeMs == null || heartbeatAgeMs > thresholds.pipeline_heartbeat_max_age_ms;
  const cycleStale = cycleAgeMs == null || cycleAgeMs > thresholds.cycle_success_max_age_ms;

  return {
    pid,
    running: alive,
    heartbeat_at: heartbeat?.ts || null,
    heartbeat_age_ms: heartbeatAgeMs,
    heartbeat_stale: heartbeatStale,
    last_successful_cycle_at: lastCycle?.ts || null,
    last_successful_cycle_age_ms: cycleAgeMs,
    last_cycle_stale: cycleStale,
    last_cycle_id: lastCycle?.cycle_id || null,
    status: !alive || heartbeatStale ? "stopped" : (cycleStale ? "degraded" : "healthy")
  };
}

function dashboardStatusSummary(generatedAtMs, thresholds, heartbeatFile = DASHBOARD_HEARTBEAT_FILE) {
  const heartbeat = readJsonFile(heartbeatFile, null);
  const pid = Number.isFinite(Number(heartbeat?.pid)) ? Number(heartbeat.pid) : null;
  const alive = isProcessAlive(pid);
  const heartbeatMs = optionalMs(heartbeat?.updated_at);
  const ageMs = heartbeatMs == null ? null : Math.max(0, generatedAtMs - heartbeatMs);
  const stale = ageMs == null || ageMs > thresholds.dashboard_heartbeat_max_age_ms;
  return {
    pid,
    running: alive,
    heartbeat_at: heartbeat?.updated_at || null,
    heartbeat_age_ms: ageMs,
    heartbeat_stale: stale,
    host: heartbeat?.host || null,
    port: heartbeat?.port ?? null,
    status: !alive || stale ? "stopped" : "healthy"
  };
}

function computeDailyRealizedPnlUsd(portfolio, evaluationTs, timezone = null) {
  const dayKey = localDayKey(evaluationTs, timezone);
  return round((Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .filter((trade) => String(trade?.side || "").toLowerCase() === "sell")
    .filter((trade) => localDayKey(trade?.ts, timezone) === dayKey)
    .reduce((sum, trade) => sum + toNum(trade?.pnl_usd, 0), 0), 2);
}

function computeDrawdownPct(portfolio = {}) {
  const currentEquity = toNum(portfolio?.stats?.equity_usd, NaN);
  const peakEquity = toNum(portfolio?.stats?.peak_equity_usd, NaN);
  if (Number.isFinite(currentEquity) && Number.isFinite(peakEquity) && peakEquity > 0) {
    return round(Math.max(0, (peakEquity - currentEquity) / peakEquity), 6);
  }
  return round(Math.max(0, toNum(portfolio?.stats?.max_drawdown_pct, 0)), 6);
}

function portfolioSafetySummary(portfolio, reports = {}) {
  const currentMode = String(portfolio?.settings?.paper_mode === false ? "research" : "paper");
  const mutationChecks = [
    reports.backtest?.report?.safety?.portfolio_json_mutated,
    reports.attribution?.report?.safety?.portfolio_json_mutated
  ].filter((value) => value != null);
  const liveCapability = evaluateLiveCapabilityStatus({
    mode: currentMode,
    portfolio
  });
  return {
    operating_mode: currentMode,
    paper_mode_enabled: Boolean(portfolio?.settings?.paper_mode),
    live_submission_enabled: false,
    live_submission_attempted: false,
    latest_report_detected_portfolio_mutation: mutationChecks.some(Boolean),
    live_capability_status: liveCapability.capability_status,
    live_capability_blockers: liveCapability.blockers
  };
}

function reportFreshness(entry, generatedAtMs, maxAgeMs) {
  const report = entry?.report || null;
  const tsMs = optionalMs(report?.generated_at);
  const ageMs = tsMs == null ? null : Math.max(0, generatedAtMs - tsMs);
  return {
    available: Boolean(report),
    generated_at: report?.generated_at || null,
    age_ms: ageMs,
    stale: ageMs == null || ageMs > maxAgeMs,
    report_id: report?.report_id || null,
    report_file: report?.report_file || (entry?.filePath ? path.relative(ROOT, entry.filePath) : null)
  };
}

function dataSourceHealthSummary(performanceEntry, generatedAtMs, thresholds) {
  const report = performanceEntry?.report || null;
  const freshness = reportFreshness(performanceEntry, generatedAtMs, thresholds.daily_performance_max_age_ms);
  const quality = report?.market_data_quality || null;
  const degraded = toNum(quality?.degraded_count, 0) > 0;
  const staleCount = toNum(quality?.stale_count, 0);
  const blockerCount = toNum(quality?.blocker_count, 0);
  const status = !freshness.available || freshness.stale
    ? "stale"
    : (blockerCount > 0 || degraded || staleCount > 0 ? "degraded" : "healthy");
  return {
    status,
    source_report: freshness,
    market_data_quality: {
      snapshot_count: toNum(quality?.snapshot_count, 0),
      degraded_count: toNum(quality?.degraded_count, 0),
      stale_count: staleCount,
      blocker_count: blockerCount,
      warning_count: toNum(quality?.warning_count, 0),
      average_confidence: quality?.average_confidence ?? null
    }
  };
}

function venueAndSignerHealthSummary(portfolio = {}) {
  const status = evaluateLiveCapabilityStatus({
    mode: "paper",
    portfolio
  });
  const venueChecks = status.checks.filter((item) => item.code.includes("venue"));
  const walletChecks = status.checks.filter((item) => item.code.includes("wallet"));
  const signerChecks = status.checks.filter((item) => item.code.includes("signer") || item.code.includes("nonce") || item.code.includes("secret"));
  const summarizeChecks = (checks) => {
    if (!checks.length) return "unknown";
    if (checks.some((item) => item.status === "block")) return "blocked";
    if (checks.some((item) => item.status === "warn")) return "degraded";
    return "healthy";
  };
  return {
    venue_health: summarizeChecks(venueChecks),
    wallet_signer_health: summarizeChecks([...walletChecks, ...signerChecks]),
    checks: {
      venue: venueChecks,
      wallet: walletChecks,
      signer: signerChecks
    }
  };
}

function collectOrderRecords(portfolio = {}) {
  const records = [
    ...(Array.isArray(portfolio?.action_history) ? portfolio.action_history : []),
    ...(Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
  ];
  const seen = new Set();
  return records
    .map((record) => record?.order_lifecycle || null)
    .filter((order) => order?.order_id)
    .filter((order) => {
      if (seen.has(order.order_id)) return false;
      seen.add(order.order_id);
      return true;
    });
}

function orderQueueHealthSummary(portfolio = {}, generatedAtMs, thresholds) {
  const orders = collectOrderRecords(portfolio);
  const active = [];
  const stuck = [];
  const rejected = [];

  for (const order of orders) {
    const currentState = String(order?.current_state || "planned");
    const plannedMs = optionalMs(order?.state_history?.[0]?.ts || order?.planned_at || null);
    const ageMs = plannedMs == null ? null : Math.max(0, generatedAtMs - plannedMs);
    const row = {
      order_id: order.order_id,
      trade_id: order.trade_id || null,
      symbol: order.symbol || null,
      current_state: currentState,
      age_ms: ageMs,
      planned_at: order?.state_history?.[0]?.ts || null
    };
    if (!TERMINAL_ORDER_STATES.has(currentState)) active.push(row);
    if (ageMs != null && ageMs > thresholds.order_stuck_max_age_ms && !TERMINAL_ORDER_STATES.has(currentState)) stuck.push(row);
    if (currentState === "rejected" || currentState === "failed") rejected.push(row);
  }

  return {
    total_orders: orders.length,
    active_order_count: active.length,
    stuck_order_count: stuck.length,
    rejected_order_count: rejected.length,
    status: stuck.length ? "stuck" : (rejected.length ? "degraded" : "healthy"),
    active_orders: active.slice(0, 25),
    stuck_orders: stuck.slice(0, 25),
    recently_rejected_orders: rejected.slice(-25)
  };
}

function promotionBlockersSummary(promotionEntry, generatedAtMs, thresholds) {
  const freshness = reportFreshness(promotionEntry, generatedAtMs, thresholds.promotion_max_age_ms);
  const report = promotionEntry?.report || null;
  return {
    source_report: freshness,
    promotion_allowed: Boolean(report?.promotion_allowed),
    promotion_decision: report?.promotion_decision || null,
    blocker_count: Array.isArray(report?.blockers) ? report.blockers.length : 0,
    blockers: Array.isArray(report?.blockers)
      ? report.blockers.map((item) => ({
        code: item?.code || item?.key || String(item || ""),
        detail: item?.detail || item?.label || null
      }))
      : []
  };
}

function missingReportsSummary(entries, generatedAtMs, thresholds) {
  return {
    performance: reportFreshness(entries.performance, generatedAtMs, thresholds.daily_performance_max_age_ms),
    backtest: reportFreshness(entries.backtest, generatedAtMs, thresholds.backtest_max_age_ms),
    promotion: reportFreshness(entries.promotion, generatedAtMs, thresholds.promotion_max_age_ms),
    attribution: reportFreshness(entries.attribution, generatedAtMs, thresholds.attribution_max_age_ms),
    reconciliation: reportFreshness(entries.reconciliation, generatedAtMs, thresholds.reconciliation_max_age_ms)
  };
}

function buildAlerts(context) {
  const alerts = [];
  const pushAlert = (code, severity, summary, detail, extras = {}) => {
    const entityKey = extras.entity_key || "global";
    const observedAt = extras.observed_at || context.generatedAt;
    alerts.push({
      alert_key: `${code}:${entityKey}`,
      code,
      severity,
      status: "active",
      summary,
      detail,
      observed_at: observedAt,
      entity_key: entityKey,
      context: extras.context || null
    });
  };

  if (!context.pipeline.running || context.pipeline.heartbeat_stale) {
    pushAlert(
      "trading_loop_stopped",
      "critical",
      "Pipeline is not running or heartbeat is stale.",
      `running=${context.pipeline.running} heartbeat_stale=${context.pipeline.heartbeat_stale}`,
      { observed_at: context.pipeline.heartbeat_at || context.generatedAt }
    );
  }

  if (context.dailyRealizedPnlUsd <= -Math.abs(context.riskPolicy.daily_realized_loss_limit_usd)) {
    pushAlert(
      "daily_loss_limit_breached",
      "critical",
      "Daily realized loss limit breached.",
      `realized_pnl_usd=${context.dailyRealizedPnlUsd} limit_usd=-${Math.abs(context.riskPolicy.daily_realized_loss_limit_usd)}`,
      { context: { realized_pnl_usd: context.dailyRealizedPnlUsd, limit_usd: context.riskPolicy.daily_realized_loss_limit_usd } }
    );
  }

  if (context.currentDrawdownPct >= context.riskPolicy.daily_equity_drawdown_limit_pct) {
    pushAlert(
      "drawdown_limit_breached",
      "critical",
      "Configured drawdown limit breached.",
      `drawdown_pct=${context.currentDrawdownPct} limit_pct=${context.riskPolicy.daily_equity_drawdown_limit_pct}`,
      { context: { drawdown_pct: context.currentDrawdownPct, limit_pct: context.riskPolicy.daily_equity_drawdown_limit_pct } }
    );
  }

  if (context.newBuyBlockActive) {
    pushAlert(
      "new_buy_block_activated",
      "high",
      "A buy-blocking risk control is active.",
      `latest_blockers=${context.latestRiskBlockers.join(", ") || "unknown"}`,
      { observed_at: context.latestRiskDecisionAt || context.generatedAt, context: { blockers: context.latestRiskBlockers } }
    );
  }

  if (context.dataSourceHealth.status === "stale" || context.dataSourceHealth.market_data_quality.stale_count > 0) {
    pushAlert(
      "stale_market_data",
      "high",
      "Market data quality is stale or its source report is outdated.",
      `status=${context.dataSourceHealth.status} stale_count=${context.dataSourceHealth.market_data_quality.stale_count}`,
      { observed_at: context.dataSourceHealth.source_report.generated_at || context.generatedAt }
    );
  }

  if (context.orderQueue.stuck_order_count > 0) {
    pushAlert(
      "order_stuck",
      "high",
      "One or more orders are non-terminal beyond the stuck threshold.",
      `stuck_order_count=${context.orderQueue.stuck_order_count}`,
      {
        entity_key: "queue",
        observed_at: context.orderQueue.stuck_orders[0]?.planned_at || context.generatedAt,
        context: { stuck_orders: context.orderQueue.stuck_orders.slice(0, 10) }
      }
    );
  } else if (context.orderQueue.rejected_order_count > 0) {
    pushAlert(
      "order_rejected",
      "medium",
      "One or more orders were rejected or failed.",
      `rejected_order_count=${context.orderQueue.rejected_order_count}`,
      { entity_key: "queue", context: { rejected_orders: context.orderQueue.recently_rejected_orders.slice(0, 10) } }
    );
  }

  if (!context.reconciliationAvailable) {
    pushAlert(
      "reconciliation_mismatch",
      "medium",
      "Reconciliation report is unavailable, so reconciliation status is effectively unresolved.",
      "Phase 12 reconciliation artifacts were not found.",
      { entity_key: "phase12_missing" }
    );
  } else if (context.reconciliationStatus !== "reconciled") {
    pushAlert(
      "reconciliation_mismatch",
      "high",
      "Latest reconciliation report has mismatches.",
      `status=${context.reconciliationStatus} critical_issues=${context.reconciliationCriticalIssueCount}`,
      {
        entity_key: "latest_reconciliation",
        observed_at: context.reconciliationGeneratedAt || context.generatedAt,
        context: {
          status: context.reconciliationStatus,
          issue_count: context.reconciliationIssueCount,
          critical_issue_count: context.reconciliationCriticalIssueCount
        }
      }
    );
  }

  if (!context.auth.connected || context.auth.lastError) {
    pushAlert(
      "api_credentials_missing_or_invalid",
      "high",
      "Stored E3D credentials are missing or have a recorded error.",
      context.auth.connected ? String(context.auth.lastError || "auth_error") : "no_connected_auth_record",
      { observed_at: context.auth.updatedAt || context.generatedAt }
    );
  }

  if (context.portfolioSafety.latest_report_detected_portfolio_mutation) {
    pushAlert(
      "portfolio_mutation_safety_failed",
      "critical",
      "A non-paper report indicated unexpected portfolio.json mutation.",
      "Backtest/attribution safety metadata reported portfolio mutation.",
      { entity_key: "portfolio_json" }
    );
  }

  if (!context.missingReports.performance.available || context.missingReports.performance.stale) {
    pushAlert(
      "missing_performance_report",
      "medium",
      "Daily performance report is missing or stale.",
      `available=${context.missingReports.performance.available} stale=${context.missingReports.performance.stale}`,
      { observed_at: context.missingReports.performance.generated_at || context.generatedAt }
    );
  }

  if (!context.missingReports.backtest.available) {
    pushAlert(
      "missing_backtest_report",
      "medium",
      "Backtest report is missing.",
      "No Phase 1 backtest report found.",
      { entity_key: "backtest" }
    );
  }

  if (context.promotionBlockers.blocker_count > 0) {
    pushAlert(
      "promotion_blockers_present",
      "medium",
      "Latest promotion gate still has blockers.",
      `blocker_count=${context.promotionBlockers.blocker_count}`,
      {
        observed_at: context.promotionBlockers.source_report.generated_at || context.generatedAt,
        context: { blockers: context.promotionBlockers.blockers.slice(0, 20) }
      }
    );
  }

  if (context.dashboard.status !== "healthy") {
    pushAlert(
      "dashboard_heartbeat_stale",
      "medium",
      "Dashboard heartbeat is stale or the server process is not alive.",
      `running=${context.dashboard.running} heartbeat_stale=${context.dashboard.heartbeat_stale}`,
      { observed_at: context.dashboard.heartbeat_at || context.generatedAt }
    );
  }

  return alerts;
}

function loadIncidentFiles(dirPath = INCIDENTS_DIR) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter((name) => /^incident-[a-f0-9]{16}\.json$/.test(name))
      .map((name) => readJsonFile(path.join(dirPath, name), null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function incidentFromAlert(alert, priorActive = null, generatedAt = nowIso()) {
  const fingerprint = `${alert.code}:${alert.entity_key || "global"}`;
  const startedAt = priorActive?.start_time || alert.observed_at || generatedAt;
  const incidentId = priorActive?.incident_id || `incident-${sha256(`${fingerprint}:${startedAt}`).slice(0, 16)}`;
  return {
    incident_id: incidentId,
    incident_fingerprint: fingerprint,
    status: "active",
    severity: alert.severity,
    title: alert.summary,
    start_time: startedAt,
    end_time: null,
    alert_code: alert.code,
    entity_key: alert.entity_key || "global",
    root_cause: priorActive?.root_cause || null,
    remediation: priorActive?.remediation || null,
    detail: alert.detail,
    latest_observed_at: alert.observed_at || generatedAt,
    review_template: {
      root_cause: priorActive?.review_template?.root_cause || "pending_review",
      remediation: priorActive?.review_template?.remediation || "pending_review",
      follow_up_actions: priorActive?.review_template?.follow_up_actions || [],
      evidence: priorActive?.review_template?.evidence || []
    },
    source_alert: alert
  };
}

function resolveStaleIncidents(activeIncidents, priorIncidents, generatedAt) {
  const currentFingerprints = new Set(activeIncidents.map((item) => item.incident_fingerprint));
  return priorIncidents
    .filter((item) => item?.status === "active")
    .filter((item) => !currentFingerprints.has(item.incident_fingerprint))
    .map((item) => ({
      ...item,
      status: "resolved",
      end_time: generatedAt,
      resolved_at: generatedAt
    }));
}

function readLastAlertStatus(logFile = OPERATIONS_ALERT_LOG) {
  const rows = readJsonLines(logFile);
  const latest = new Map();
  for (const row of rows) {
    if (!row?.alert_key) continue;
    latest.set(row.alert_key, row);
  }
  return latest;
}

function buildAlertEvents(alerts, resolvedIncidents, generatedAt, logFile = OPERATIONS_ALERT_LOG) {
  const lastStatus = readLastAlertStatus(logFile);
  const events = [];

  for (const alert of alerts) {
    const payload = { ...alert };
    const previous = lastStatus.get(alert.alert_key);
    if (!previous || previous.status !== "active" || stableStringify(previous.context || null) !== stableStringify(alert.context || null)) {
      events.push({
        event_id: `opsalert_${sha256(`${alert.alert_key}:active:${generatedAt}:${stableStringify(alert.context || null)}`).slice(0, 24)}`,
        ts: generatedAt,
        event_type: "operations_alert",
        status: "active",
        ...payload
      });
    }
  }

  for (const incident of resolvedIncidents) {
    const alertKey = `${incident.alert_code}:${incident.entity_key || "global"}`;
    const previous = lastStatus.get(alertKey);
    if (!previous || previous.status !== "resolved") {
      events.push({
        event_id: `opsalert_${sha256(`${alertKey}:resolved:${generatedAt}`).slice(0, 24)}`,
        ts: generatedAt,
        event_type: "operations_alert",
        status: "resolved",
        alert_key: alertKey,
        code: incident.alert_code,
        severity: incident.severity,
        summary: incident.title,
        detail: incident.detail,
        observed_at: incident.latest_observed_at || incident.end_time || generatedAt,
        entity_key: incident.entity_key || "global",
        context: { incident_id: incident.incident_id, resolved_at: incident.end_time || generatedAt }
      });
    }
  }

  return events;
}

function operationsStatusFromAlerts(alerts, portfolioSafety, pipeline) {
  if (!pipeline.running || alerts.some((item) => item.severity === "critical" && item.code === "trading_loop_stopped")) return "failed";
  if (portfolioSafety.paper_mode_enabled === false) return "paused";
  if (alerts.some((item) => item.severity === "critical" || item.severity === "high")) return "degraded";
  return "trading";
}

function markdownReport(report) {
  const lines = [
    "# Operations Monitor",
    "",
    `- Report ID: ${report.report_id}`,
    `- Generated at: ${report.generated_at}`,
    `- Status: ${report.overall_status}`,
    `- Active alerts: ${report.alerts.active_count}`,
    `- Active incidents: ${report.incidents.active_count}`,
    "",
    "## Health",
    "",
    `- Pipeline: ${report.health.pipeline.status}`,
    `- Dashboard: ${report.health.dashboard.status}`,
    `- Data sources: ${report.health.data_sources.status}`,
    `- Order queue: ${report.health.order_queue.status}`,
    `- Venue health: ${report.health.venue_and_signer.venue_health}`,
    `- Wallet signer health: ${report.health.venue_and_signer.wallet_signer_health}`,
    "",
    "## Active Alerts",
    ""
  ];

  if (!report.alerts.active.length) {
    lines.push("- None");
  } else {
    for (const alert of report.alerts.active) {
      lines.push(`- [${alert.severity}] ${alert.code}: ${alert.detail}`);
    }
  }

  lines.push("", "## Active Incidents", "");
  if (!report.incidents.active.length) {
    lines.push("- None");
  } else {
    for (const incident of report.incidents.active) {
      lines.push(`- ${incident.incident_id}: ${incident.title}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeJsonLines(filePath, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

export function generateOperationsMonitorReport(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const generatedAtMs = optionalMs(generatedAt) || Date.now();
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds || {})
  };

  const portfolio = readJsonFile(options.portfolioFile || PORTFOLIO_FILE, {});
  const pipelineLog = readJsonLines(options.pipelineLog || PIPELINE_LOG);
  const trainingEvents = readJsonLines(options.trainingEventLog || TRAINING_EVENT_LOG);
  const auth = typeof options.authStatus === "function" ? options.authStatus() : (options.authStatus || getAuthStatus());
  const performance = latestPerformanceReport(options);
  const backtest = latestBacktestReport(options);
  const promotion = latestPromotionReport(options);
  const attribution = latestAttributionReport(options);
  const reconciliation = latestReconciliationReport(options);

  const pipeline = pipelineStatusSummary(
    pipelineLog,
    trainingEvents,
    generatedAtMs,
    thresholds,
    options.pipelinePidFile || PIPELINE_PID_FILE
  );
  const dashboard = dashboardStatusSummary(generatedAtMs, thresholds, options.dashboardHeartbeatFile || DASHBOARD_HEARTBEAT_FILE);
  const dataSourceHealth = dataSourceHealthSummary(performance, generatedAtMs, thresholds);
  const venueAndSigner = venueAndSignerHealthSummary(portfolio);
  const orderQueue = orderQueueHealthSummary(portfolio, generatedAtMs, thresholds);
  const portfolioSafety = portfolioSafetySummary(portfolio, { backtest, attribution });
  const promotionBlockers = promotionBlockersSummary(promotion, generatedAtMs, thresholds);
  const missingReports = missingReportsSummary({ performance, backtest, promotion, attribution, reconciliation }, generatedAtMs, thresholds);
  const riskPolicy = resolveRiskPolicy(portfolio, options.riskPolicy || null);
  const dailyRealizedPnlUsd = computeDailyRealizedPnlUsd(portfolio, generatedAt);
  const currentDrawdownPct = computeDrawdownPct(portfolio);
  const latestRiskDecisionEvent = latestRiskEngineDecision(trainingEvents);
  const latestRiskDecision = latestRiskDecisionEvent?.payload?.risk_decision || null;
  const latestRiskBlockers = Array.isArray(latestRiskDecision?.blockers) ? latestRiskDecision.blockers : [];
  const newBuyBlockActive = latestRiskDecision?.side === "buy" && latestRiskDecision?.decision === "block" && latestRiskBlockers.length > 0;
  const reconciliationReport = reconciliation?.report || null;
  const reconciliationAvailable = Boolean(reconciliationReport);
  const reconciliationStatus = reconciliationReport?.status || (reconciliationAvailable ? "unknown" : "missing_phase_12_artifacts");
  const reconciliationIssues = Array.isArray(reconciliationReport?.issues) ? reconciliationReport.issues : [];
  const reconciliationCriticalIssueCount = reconciliationIssues.filter((issue) => issue?.severity === "critical").length;

  const alerts = buildAlerts({
    generatedAt,
    pipeline,
    dashboard,
    auth,
    riskPolicy,
    dailyRealizedPnlUsd,
    currentDrawdownPct,
    newBuyBlockActive,
    latestRiskDecisionAt: latestRiskDecisionEvent?.ts || null,
    latestRiskBlockers,
    dataSourceHealth,
    orderQueue,
    portfolioSafety,
    promotionBlockers,
    missingReports,
    reconciliationAvailable,
    reconciliationStatus,
    reconciliationGeneratedAt: reconciliationReport?.generated_at || null,
    reconciliationIssueCount: reconciliationIssues.length,
    reconciliationCriticalIssueCount
  }).sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const priorIncidents = loadIncidentFiles(options.incidentsDir || INCIDENTS_DIR);
  const activeByFingerprint = new Map(priorIncidents.filter((item) => item?.status === "active").map((item) => [item.incident_fingerprint, item]));
  const activeIncidents = alerts.map((alert) => incidentFromAlert(alert, activeByFingerprint.get(`${alert.code}:${alert.entity_key || "global"}`), generatedAt));
  const resolvedIncidents = resolveStaleIncidents(activeIncidents, priorIncidents, generatedAt);
  const alertEvents = buildAlertEvents(alerts, resolvedIncidents, generatedAt, options.operationsAlertLog || OPERATIONS_ALERT_LOG);
  const overallStatus = operationsStatusFromAlerts(alerts, portfolioSafety, pipeline);

  const reportTimestamp = formatReportTimestamp(new Date(generatedAtMs));
  const reportFile = `reports/operations/operations-${reportTimestamp}.json`;
  const markdownFile = `reports/operations/operations-${reportTimestamp}.md`;
  const reportId = `operations-${sha256(`${generatedAt}:${stableStringify({
    overallStatus,
    alert_keys: alerts.map((item) => item.alert_key),
    pipeline: pipeline.status,
    dashboard: dashboard.status
  })}`).slice(0, 16)}`;

  const report = {
    report_id: reportId,
    report_type: "operations_monitor",
    schema_version: "1.0",
    generated_at: generatedAt,
    report_file: reportFile,
    markdown_file: markdownFile,
    overall_status: overallStatus,
    live_trading_enabled: false,
    live_submission_enabled: false,
    data_sources: {
      portfolio_json: path.relative(ROOT, options.portfolioFile || PORTFOLIO_FILE),
      pipeline_jsonl: path.relative(ROOT, options.pipelineLog || PIPELINE_LOG),
      training_events_jsonl: path.relative(ROOT, options.trainingEventLog || TRAINING_EVENT_LOG),
      operations_alerts_jsonl: path.relative(ROOT, options.operationsAlertLog || OPERATIONS_ALERT_LOG),
      dashboard_heartbeat: path.relative(ROOT, options.dashboardHeartbeatFile || DASHBOARD_HEARTBEAT_FILE),
      reconciliation_report: reconciliation?.filePath ? path.relative(ROOT, reconciliation.filePath) : null
    },
    health: {
      pipeline,
      dashboard,
      data_sources: dataSourceHealth,
      venue_and_signer: venueAndSigner,
      order_queue: orderQueue,
      portfolio_safety: portfolioSafety,
      missing_reports: missingReports,
      promotion_blockers: promotionBlockers,
      reconciliation: {
        source_report: missingReports.reconciliation,
        status: reconciliationStatus,
        live_trading_blocked: Boolean(reconciliationReport?.live_trading_blocked),
        issue_count: reconciliationIssues.length,
        critical_issue_count: reconciliationCriticalIssueCount
      }
    },
    risk_snapshot: {
      policy_version: latestRiskDecision?.policy_version || null,
      daily_realized_pnl_usd: dailyRealizedPnlUsd,
      daily_realized_loss_limit_usd: riskPolicy.daily_realized_loss_limit_usd,
      current_drawdown_pct: currentDrawdownPct,
      drawdown_limit_pct: riskPolicy.daily_equity_drawdown_limit_pct,
      latest_buy_block_active: newBuyBlockActive,
      latest_risk_decision_id: latestRiskDecision?.risk_decision_id || null,
      latest_risk_decision_at: latestRiskDecisionEvent?.ts || null,
      latest_buy_blockers: latestRiskBlockers
    },
    alerts: {
      active_count: alerts.length,
      active: alerts,
      emitted_event_count: alertEvents.length
    },
    incidents: {
      active_count: activeIncidents.length,
      resolved_count: resolvedIncidents.length,
      active: activeIncidents,
      resolved: resolvedIncidents
    },
    reconciliation: {
      report_available: reconciliationAvailable,
      status: reconciliationStatus,
      live_trading_blocked: Boolean(reconciliationReport?.live_trading_blocked),
      issue_count: reconciliationIssues.length,
      critical_issue_count: reconciliationCriticalIssueCount,
      report_id: reconciliationReport?.report_id || null,
      report_file: reconciliationReport?.report_file || null
    }
  };

  if (options.writeReport !== false) {
    fs.mkdirSync(options.operationsReportDir || OPERATIONS_REPORT_DIR, { recursive: true });
    fs.mkdirSync(options.incidentsDir || INCIDENTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report), "utf8");
    for (const incident of [...activeIncidents, ...resolvedIncidents]) {
      fs.writeFileSync(path.join(options.incidentsDir || INCIDENTS_DIR, `${incident.incident_id}.json`), `${JSON.stringify(incident, null, 2)}\n`, "utf8");
    }
  }

  if (options.writeEvents !== false) {
    writeJsonLines(options.operationsAlertLog || OPERATIONS_ALERT_LOG, alertEvents);
  }

  return report;
}

function parseArgs(argv) {
  const get = (name, fallback = null) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  return {
    generatedAt: get("generated-at", null),
    writeReport: !argv.includes("--no-write-report"),
    writeEvents: !argv.includes("--no-write-events")
  };
}

if (process.argv[1] === __filename) {
  const report = generateOperationsMonitorReport(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    report_id: report.report_id,
    report_file: report.report_file,
    markdown_file: report.markdown_file,
    overall_status: report.overall_status,
    active_alert_count: report.alerts.active_count,
    active_incident_count: report.incidents.active_count
  }, null, 2));
}
