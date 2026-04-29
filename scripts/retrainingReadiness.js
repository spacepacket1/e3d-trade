import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(ROOT, "reports");
const TRADE_REVIEWS_LOG = path.join(LOG_DIR, "trade-reviews.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const READINESS_FILE = path.join(REPORTS_DIR, "retraining-readiness.json");

function nowIso() {
  return new Date().toISOString();
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

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function groupCounts(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = String(keyFn(item) || "unknown");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function latestPerformanceReports() {
  try {
    return fs.readdirSync(REPORTS_DIR)
      .filter((name) => /^performance-daily-\d{8}\.json$/.test(name))
      .map((name) => readJsonFile(path.join(REPORTS_DIR, name)))
      .filter((report) => report?.report_type === "daily_performance")
      .sort((a, b) => String(b.generated_at || "").localeCompare(String(a.generated_at || "")));
  } catch {
    return [];
  }
}

function consecutiveRegressionCount(reports) {
  let count = 0;
  for (const report of reports) {
    const metrics = report?.windows?.["24h"]?.metrics || {};
    const realized = Number(metrics.realized_pnl_usd || 0);
    const profitFactor = Number(metrics.profit_factor || 0);
    if (realized < 0 && profitFactor < 1) count += 1;
    else break;
  }
  return count;
}

function recommendationForAgent(reviews) {
  const negativeByAgent = groupCounts(
    reviews.filter((review) => review.training_label === "negative"),
    (review) => review.primary_error_agent || "unknown"
  );
  const top = negativeByAgent[0];
  if (!top || top.count < 40) return "hold";
  if (["scout", "harvest", "risk", "executor"].includes(top.key)) return `train_${top.key}`;
  return "hold";
}

export function generateRetrainingReadiness(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const reviews = readJsonLines(options.reviewLog || TRADE_REVIEWS_LOG);
  const reports = latestPerformanceReports();
  const positive = reviews.filter((review) => review.training_label === "positive");
  const negative = reviews.filter((review) => review.training_label === "negative");
  const neutral = reviews.filter((review) => review.training_label === "neutral");
  const byFailure = groupCounts(negative, (review) => `${review.primary_error_agent || "unknown"}:${review.setup_label || "unknown"}`);
  const bySuccess = groupCounts(positive, (review) => `${review.primary_success_agent || "unknown"}:${review.setup_label || "unknown"}`);
  const byToken = groupCounts(reviews, (review) => review.contract_address || review.symbol);
  const byDay = groupCounts(reviews, (review) => String(review.reviewed_at || "").slice(0, 10));
  const byRegime = groupCounts(reviews, (review) => review.market_regime_label || "unknown");
  const regressionDays = consecutiveRegressionCount(reports);

  const blockers = [];
  if (reviews.length < 30) blockers.push("fewer_than_30_reviewed_examples");
  if (neutral.length > positive.length + negative.length) blockers.push("labels_mostly_neutral");
  if (reviews.length > 0 && byToken[0]?.count / reviews.length > 0.3) blockers.push("one_token_dominates_examples");
  if (reviews.length > 0 && byDay[0]?.count / reviews.length > 0.5) blockers.push("one_day_dominates_examples");
  if (byRegime.length < 2 && reviews.length >= 30) blockers.push("examples_not_regime_balanced");

  const eligibleReasons = [];
  if (reviews.length >= 100) eligibleReasons.push("at_least_100_reviewed_examples");
  if (byFailure[0]?.count >= 40) eligibleReasons.push("single_failure_class_threshold_met");
  if (bySuccess[0]?.count >= 40) eligibleReasons.push("single_success_class_threshold_met");
  if (regressionDays >= 3) eligibleReasons.push("three_consecutive_daily_scorecard_regressions");
  if (negative.filter((review) => review.primary_error_agent === "scout").length >= 5) eligibleReasons.push("repeated_scout_failure_pattern");
  if (negative.filter((review) => review.primary_error_agent === "harvest" && review.avoidable_loss).length >= 3) eligibleReasons.push("harvest_avoidable_exit_cluster");

  const eligible = blockers.length === 0 && eligibleReasons.length > 0;
  const recommendation = eligible ? recommendationForAgent(reviews) : "hold";
  const reason = blockers[0] || eligibleReasons[0] || "not_enough_reviewed_examples";
  const report = {
    generated_at: generatedAt,
    eligible,
    recommendation,
    reason,
    blockers,
    eligibility_reasons: eligibleReasons,
    new_review_count: reviews.length,
    positive_examples: positive.length,
    negative_examples: negative.length,
    neutral_examples: neutral.length,
    dominant_failure_modes: byFailure.slice(0, 8),
    dominant_success_modes: bySuccess.slice(0, 8),
    dominant_tokens: byToken.slice(0, 5),
    review_days: byDay.slice(0, 5),
    regime_balance: byRegime,
    regression_daily_scorecards: regressionDays
  };

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(options.outputFile || READINESS_FILE, `${JSON.stringify(report, null, 2)}\n`);
  if (options.appendEvent !== false) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(TRAINING_EVENT_LOG, `${JSON.stringify({
      event_id: crypto.randomUUID(),
      schema_version: "1.0",
      ts: generatedAt,
      event_type: "retraining_readiness",
      actor: "manager",
      pipeline_run_id: null,
      cycle_id: null,
      cycle_index: -1,
      market_regime: byRegime[0]?.key || "unknown",
      candidate_id: null,
      position_id: null,
      trade_id: null,
      payload: {
        eligible: report.eligible,
        recommendation: report.recommendation,
        reason: report.reason,
        new_review_count: report.new_review_count,
        positive_examples: report.positive_examples,
        negative_examples: report.negative_examples,
        neutral_examples: report.neutral_examples
      }
    })}\n`);
  }

  return report;
}

if (process.argv[1] === __filename) {
  const report = generateRetrainingReadiness({ appendEvent: !process.argv.includes("--no-append-event") });
  console.log(JSON.stringify({
    generated_at: report.generated_at,
    eligible: report.eligible,
    recommendation: report.recommendation,
    reason: report.reason,
    new_review_count: report.new_review_count
  }, null, 2));
}
