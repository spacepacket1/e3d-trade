import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const LOG_DIR = path.join(ROOT, "logs");
const TRADE_REVIEWS_LOG = path.join(LOG_DIR, "trade-reviews.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(filePath, fallback) {
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

function normalize(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function cleanAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function hoursBetween(start, end) {
  const startMs = new Date(start || 0).getTime();
  const endMs = new Date(end || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs <= 0 || endMs <= 0) return null;
  return Math.max(0, (endMs - startMs) / 3600000);
}

function reasonRoot(reason) {
  const text = normalize(reason);
  return text.includes(":") ? text.split(":")[0] : text;
}

function classifyExitReason(reason) {
  const root = reasonRoot(reason).toLowerCase();
  if (root.startsWith("target_")) return "target_hit";
  if (root.includes("stop")) return "stop_loss";
  if (root.includes("harvest")) return "harvest_exit";
  if (root.includes("rotation_out")) return "rotation_out";
  if (root.includes("non_tradeable") || root.includes("non-tradeable")) return "non_tradeable_force_exit";
  return root || "unknown";
}

function buildEventIndex(events) {
  const byPosition = new Map();
  const byCandidate = new Map();
  const byTrade = new Map();

  for (const event of events) {
    if (event?.position_id) {
      if (!byPosition.has(event.position_id)) byPosition.set(event.position_id, []);
      byPosition.get(event.position_id).push(event);
    }
    if (event?.candidate_id) {
      const key = cleanAddress(event.candidate_id);
      if (!byCandidate.has(key)) byCandidate.set(key, []);
      byCandidate.get(key).push(event);
    }
    if (event?.trade_id) {
      if (!byTrade.has(event.trade_id)) byTrade.set(event.trade_id, []);
      byTrade.get(event.trade_id).push(event);
    }
  }

  return { byPosition, byCandidate, byTrade };
}

function relatedEvents(trade, index) {
  const events = [
    ...(index.byTrade.get(trade.trade_id) || []),
    ...(index.byPosition.get(trade.position_id) || []),
    ...(index.byCandidate.get(cleanAddress(trade.candidate_id || trade.contract_address)) || [])
  ];
  const seen = new Set();
  return events
    .filter((event) => {
      const id = event.event_id || `${event.ts}-${event.event_type}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}

function latest(events, predicate) {
  return [...events].reverse().find(predicate) || null;
}

function extractEvidenceMetadata(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const summary = source?.evidence_summary && typeof source.evidence_summary === "object"
      ? source.evidence_summary
      : null;
    const refs = cleanList(
      source?.evidence_refs
      || source?.evidence
      || summary?.refs_used
    );
    const labels = cleanList((Array.isArray(summary?.highlights) ? summary.highlights : [])
      .flatMap((item) => [item?.label, item?.source_type]));
    const evidencePacketId = source?.evidence_packet_id || summary?.evidence_packet_id || null;
    if (!evidencePacketId && !refs.length && !labels.length) continue;
    return {
      evidence_packet_id: evidencePacketId,
      evidence_quality_score: source?.evidence_quality_score ?? summary?.quality_score ?? null,
      evidence_ref_count: source?.evidence_ref_count ?? refs.length,
      evidence_refs: refs,
      story_labels: labels
    };
  }
  return {
    evidence_packet_id: null,
    evidence_quality_score: null,
    evidence_ref_count: 0,
    evidence_refs: [],
    story_labels: []
  };
}

function storyLabels(proposal, trade = null) {
  const evidenceMetadata = extractEvidenceMetadata(
    trade,
    trade?.paper_trade_ticket,
    trade?.order_lifecycle,
    proposal
  );
  if (evidenceMetadata.story_labels.length) {
    return evidenceMetadata.story_labels;
  }
  const labels = [];
  if (proposal?.setup_type) labels.push(proposal.setup_type);
  const evidence = Array.isArray(proposal?.evidence) ? proposal.evidence : [];
  for (const item of evidence) {
    if (typeof item === "object" && (item.type || item.story_type)) labels.push(item.type || item.story_type);
  }
  return [...new Set(labels.map((item) => normalize(item)).filter((item) => item !== "unknown"))];
}

function reviewTrade(trade, events, reviewedAt) {
  const pnl = toNum(trade.pnl_usd, 0);
  const cost = toNum(trade.cost_portion_usd, 0);
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const exitReason = classifyExitReason(trade.reason);
  const riskEvent = latest(events, (event) => event.event_type === "risk_decision");
  const executorEvent = latest(events, (event) => event.event_type === "executor_decision");
  const harvestEvent = latest(events, (event) => event.event_type === "harvest_decision");
  const proposal = riskEvent?.payload?.proposal || executorEvent?.payload?.proposal || harvestEvent?.payload?.proposal || null;
  const evidenceMetadata = extractEvidenceMetadata(
    trade,
    trade?.paper_trade_ticket,
    trade?.order_lifecycle,
    proposal,
    riskEvent?.payload?.risk_review
  );
  const riskCodes = riskEvent?.payload?.risk_review?.reason_codes || [];
  const executorDecision = executorEvent?.payload?.decision || executorEvent?.payload?.review?.executor_decision || trade.paper_trade_ticket?.executor_decision || null;
  const holdHours = hoursBetween(trade.opened_at, trade.ts);
  const liquidity = toNum(proposal?.liquidity_data?.liquidity_usd, trade.liquidity_usd);

  let trainingLabel = "neutral";
  if (pnl > 0 && exitReason === "target_hit") trainingLabel = "positive";
  else if (pnl > 0 && trade.trade_lifecycle === "partial_sell") trainingLabel = "positive";
  else if (pnl < 0 && (exitReason === "stop_loss" || exitReason === "non_tradeable_force_exit" || pnlPct <= -2)) trainingLabel = "negative";
  else if (pnl !== 0) trainingLabel = pnl > 0 ? "positive" : "negative";

  let entryQuality = "acceptable";
  if (riskCodes.includes("missing_market_data") || riskCodes.includes("liquidity_too_low")) entryQuality = "poor";
  if (exitReason === "non_tradeable_force_exit") entryQuality = "invalid";
  if (pnlPct > 5 && liquidity >= 100000) entryQuality = "good";
  if (pnlPct > 10 && liquidity >= 250000) entryQuality = "excellent";

  let exitQuality = "acceptable";
  if (exitReason === "target_hit" && pnl > 0) exitQuality = "good";
  if (exitReason === "harvest_exit" && pnl > 0) exitQuality = "good";
  if (exitReason === "stop_loss" && pnl < 0) exitQuality = "late";
  if (exitReason === "rotation_out" && pnl > 0) exitQuality = "acceptable";
  if (pnlPct <= -5) exitQuality = "poor";

  const allocationUsd = toNum(trade.cost_portion_usd || trade.cost_usd, 0);
  let sizingQuality = "appropriate";
  if (allocationUsd > 2500 || (pnl < 0 && Math.abs(pnl) > 40)) sizingQuality = "too_large";
  if (allocationUsd > 0 && allocationUsd < 50 && pnl > 0) sizingQuality = "too_small";

  let primaryErrorAgent = "none";
  if (pnl < 0) {
    if (exitReason === "stop_loss" || exitQuality === "late") primaryErrorAgent = "harvest";
    else if (entryQuality === "poor" || entryQuality === "invalid") primaryErrorAgent = "risk";
    else if (sizingQuality === "too_large") primaryErrorAgent = "sizer";
    else primaryErrorAgent = "scout";
  }

  let primarySuccessAgent = "scout";
  if (exitReason === "target_hit" || exitReason === "harvest_exit") primarySuccessAgent = "harvest";
  if (String(executorDecision || "").includes("reduce")) primarySuccessAgent = "executor";
  if (pnl <= 0) primarySuccessAgent = "risk";

  const avoidableLoss = pnl < 0 && (exitReason === "stop_loss" || exitReason === "non_tradeable_force_exit" || sizingQuality === "too_large");
  const lessons = [];
  if (pnl > 0 && trade.trade_lifecycle === "partial_sell") lessons.push("Profitable partial exit preserved realized gains.");
  if (pnl < 0 && exitReason === "harvest_exit") lessons.push("Harvest exit reduced exposure but realized a loss; inspect entry setup quality.");
  if (exitReason === "stop_loss") lessons.push("Stop-loss drag should reduce future sizing for this setup until expectancy improves.");
  if (liquidity > 0 && liquidity < 100000) lessons.push("Low-liquidity outcome should be treated as low-confidence training data.");
  if (!lessons.length) lessons.push("Outcome logged for future setup expectancy tracking.");

  return {
    trade_id: trade.trade_id,
    position_id: trade.position_id || null,
    symbol: normalize(trade.symbol),
    contract_address: normalize(trade.contract_address),
    reviewed_at: reviewedAt,
    entry_quality: entryQuality,
    exit_quality: exitQuality,
    sizing_quality: sizingQuality,
    primary_error_agent: primaryErrorAgent,
    primary_success_agent: primarySuccessAgent,
    avoidable_loss: avoidableLoss,
    avoidable_loss_reason: avoidableLoss ? `${exitReason}:${sizingQuality}` : "",
    setup_label: normalize(proposal?.setup_type || reasonRoot(trade.reason)),
    story_signal_labels: storyLabels(proposal, trade),
    market_regime_label: normalize(trade.market_regime || riskEvent?.market_regime || executorEvent?.market_regime, "unknown"),
    lessons,
    training_label: trainingLabel,
    recommended_rule_changes: avoidableLoss ? [`review_${primaryErrorAgent}_rules_for_${normalize(proposal?.setup_type || exitReason)}`] : [],
    evidence: {
      pnl_usd: Number(pnl.toFixed(6)),
      pnl_pct: Number(pnlPct.toFixed(4)),
      exit_reason: exitReason,
      trade_lifecycle: normalize(trade.trade_lifecycle),
      hold_time_hours: holdHours == null ? null : Number(holdHours.toFixed(2)),
      risk_reason_codes: Array.isArray(riskCodes) ? riskCodes : [],
      executor_decision: executorDecision,
      liquidity_usd: liquidity || null,
      evidence_packet_id: evidenceMetadata.evidence_packet_id,
      evidence_quality_score: evidenceMetadata.evidence_quality_score,
      evidence_ref_count: evidenceMetadata.evidence_ref_count,
      evidence_refs: evidenceMetadata.evidence_refs
    }
  };
}

function appendTrainingEvent(review, generatedAt) {
  const record = {
    event_id: crypto.randomUUID(),
    schema_version: "1.0",
    ts: generatedAt,
    event_type: "trade_review",
    actor: "trade_reviewer",
    pipeline_run_id: null,
    cycle_id: null,
    cycle_index: -1,
    market_regime: review.market_regime_label,
    candidate_id: review.contract_address,
    position_id: review.position_id,
    trade_id: review.trade_id,
    payload: {
      training_label: review.training_label,
      primary_success_agent: review.primary_success_agent,
      primary_error_agent: review.primary_error_agent,
      entry_quality: review.entry_quality,
      exit_quality: review.exit_quality,
      sizing_quality: review.sizing_quality,
      avoidable_loss: review.avoidable_loss,
      setup_label: review.setup_label
    }
  };
  fs.appendFileSync(TRAINING_EVENT_LOG, `${JSON.stringify(record)}\n`);
}

export function runTradeReviewer(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const portfolio = readJsonFile(options.portfolioFile || PORTFOLIO_FILE, {});
  const trainingEvents = readJsonLines(options.trainingEventLog || TRAINING_EVENT_LOG);
  const existingReviews = readJsonLines(options.reviewLog || TRADE_REVIEWS_LOG);
  const reviewedIds = new Set(existingReviews.map((review) => review.trade_id).filter(Boolean));
  const index = buildEventIndex(trainingEvents);
  const closedTrades = Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : [];
  const reviews = [];

  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (const trade of closedTrades) {
    if (!trade?.trade_id || reviewedIds.has(trade.trade_id)) continue;
    const review = reviewTrade(trade, relatedEvents(trade, index), generatedAt);
    fs.appendFileSync(options.reviewLog || TRADE_REVIEWS_LOG, `${JSON.stringify(review)}\n`);
    if (options.appendTrainingEvent !== false) appendTrainingEvent(review, generatedAt);
    reviewedIds.add(trade.trade_id);
    reviews.push(review);
  }

  return {
    generated_at: generatedAt,
    reviewed_count: reviews.length,
    total_review_count: reviewedIds.size,
    reviews
  };
}

if (process.argv[1] === __filename) {
  const result = runTradeReviewer({ appendTrainingEvent: !process.argv.includes("--no-training-event") });
  console.log(JSON.stringify({
    generated_at: result.generated_at,
    reviewed_count: result.reviewed_count,
    total_review_count: result.total_review_count
  }, null, 2));
}
