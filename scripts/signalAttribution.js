import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(ROOT, "reports");
const ATTRIBUTION_REPORTS_DIR = path.join(REPORTS_DIR, "attribution");
const BACKTEST_REPORTS_DIR = path.join(REPORTS_DIR, "backtests");
const PROMOTION_REPORTS_DIR = path.join(REPORTS_DIR, "promotions");
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const TRADE_REVIEWS_LOG = path.join(LOG_DIR, "trade-reviews.jsonl");
const PERFORMANCE_REPORT_GLOB = /^performance-daily-\d{8}\.json$/;
const ATTRIBUTION_REPORT_GLOB = /^signal-attribution-\d{8}-\d{6}\.json$/;
const BACKTEST_REPORT_GLOB = /^backtest-\d{8}-\d{6}\.json$/;
const PROMOTION_REPORT_GLOB = /^promotion-\d{8}-\d{6}\.json$/;
const SIGNAL_ATTRIBUTION_SCHEMA_VERSION = "1.0";
const DEFAULT_MIN_CONFIDENCE_SAMPLE = 5;
const NEGATIVE_EXPECTANCY_MIN_SAMPLE = 3;

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

function normalizeKey(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function cleanAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function reasonRoot(reason) {
  const text = normalizeKey(reason);
  return text.includes(":") ? text.split(":")[0] || "unknown" : text;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function latestByGeneratedAt(entries) {
  return [...entries]
    .filter((entry) => entry?.generated_at)
    .sort((a, b) => String(b.generated_at || "").localeCompare(String(a.generated_at || "")))[0] || null;
}

function listJsonReports(dirPath, filePattern, expectedType) {
  try {
    return fs.readdirSync(dirPath)
      .filter((name) => filePattern.test(name))
      .map((name) => path.join(dirPath, name))
      .map((filePath) => ({ filePath, report: readJsonFile(filePath, null) }))
      .filter(({ report }) => !expectedType || report?.report_type === expectedType)
      .sort((a, b) => String(b.report?.generated_at || "").localeCompare(String(a.report?.generated_at || "")));
  } catch {
    return [];
  }
}

function liquidityBucketForTrade(openTrade = {}, closeTrade = {}, riskEvent = null) {
  const bucket = openTrade?.simulated_execution?.liquidity_bucket
    || openTrade?.order_lifecycle?.simulated_execution?.liquidity_bucket
    || openTrade?.order_lifecycle?.execution_control_ref?.liquidity_depth_bucket
    || closeTrade?.simulated_execution?.liquidity_bucket
    || closeTrade?.order_lifecycle?.simulated_execution?.liquidity_bucket
    || riskEvent?.payload?.proposal?.execution_data?.liquidity_bucket
    || null;
  if (bucket) return normalizeKey(bucket);
  const liquidityUsd = toNum(
    openTrade?.paper_trade_ticket?.liquidity_usd,
    toNum(
      openTrade?.last_market_snapshot?.liquidity_data?.liquidity_usd,
      toNum(riskEvent?.payload?.proposal?.liquidity_data?.liquidity_usd, 0)
    )
  );
  if (liquidityUsd >= 1000000) return "deep";
  if (liquidityUsd >= 100000) return "medium";
  if (liquidityUsd >= 20000) return "thin";
  return liquidityUsd > 0 ? "very_thin" : "unknown";
}

function buildEventIndex(events) {
  const byCandidate = new Map();
  const byPosition = new Map();
  const byTrade = new Map();
  const candidates = new Map();
  const signalSnapshots = [];

  for (const event of events) {
    if (event?.candidate_id) {
      const key = cleanAddress(event.candidate_id) || normalizeKey(event.candidate_id);
      if (!byCandidate.has(key)) byCandidate.set(key, []);
      byCandidate.get(key).push(event);
    }
    if (event?.position_id) {
      const key = normalizeKey(event.position_id);
      if (!byPosition.has(key)) byPosition.set(key, []);
      byPosition.get(key).push(event);
    }
    if (event?.trade_id) {
      const key = normalizeKey(event.trade_id);
      if (!byTrade.has(key)) byTrade.set(key, []);
      byTrade.get(key).push(event);
    }
    if (event?.event_type === "signal_snapshot" && Array.isArray(event?.payload?.signals)) {
      signalSnapshots.push(event);
    }
    if (event?.event_type === "candidate") {
      const candidateKey = [
        normalizeKey(event.pipeline_run_id),
        normalizeKey(event.cycle_id),
        cleanAddress(event.candidate_id) || normalizeKey(event.candidate_id),
        normalizeKey(event.ts)
      ].join("|");
      if (!candidates.has(candidateKey)) candidates.set(candidateKey, { candidate: event, risk: null, executor: null });
    }
  }

  for (const event of events) {
    if (event?.event_type !== "risk_decision" && event?.event_type !== "executor_decision") continue;
    const eventKey = [
      normalizeKey(event.pipeline_run_id),
      normalizeKey(event.cycle_id),
      cleanAddress(event.candidate_id) || normalizeKey(event.candidate_id)
    ].join("|");
    for (const [candidateKey, bundle] of candidates.entries()) {
      if (!candidateKey.startsWith(`${eventKey}|`)) continue;
      const candidateTsMs = optionalMs(bundle.candidate?.ts);
      const eventTsMs = optionalMs(event.ts);
      if (candidateTsMs == null || eventTsMs == null || eventTsMs < candidateTsMs) continue;
      if (event.event_type === "risk_decision" && !bundle.risk) {
        bundle.risk = event;
      } else if (event.event_type === "executor_decision" && !bundle.executor) {
        bundle.executor = event;
      }
    }
  }

  signalSnapshots.sort((a, b) => (optionalMs(a.ts) || 0) - (optionalMs(b.ts) || 0));

  return { byCandidate, byPosition, byTrade, signalSnapshots, candidates: [...candidates.values()] };
}

function buildActionIndex(actionHistory) {
  const byPosition = new Map();
  const byCandidate = new Map();
  const buys = [];

  for (const trade of Array.isArray(actionHistory) ? actionHistory : []) {
    if (String(trade?.side || "").toLowerCase() !== "buy") continue;
    const tsMs = optionalMs(trade.ts);
    const normalized = { ...trade, ts_ms: tsMs };
    buys.push(normalized);
    if (trade?.position_id) {
      const key = normalizeKey(trade.position_id);
      if (!byPosition.has(key)) byPosition.set(key, []);
      byPosition.get(key).push(normalized);
    }
    const candidateKey = cleanAddress(trade?.candidate_id || trade?.contract_address);
    if (candidateKey) {
      if (!byCandidate.has(candidateKey)) byCandidate.set(candidateKey, []);
      byCandidate.get(candidateKey).push(normalized);
    }
  }

  const sortTrades = (a, b) => (a.ts_ms || 0) - (b.ts_ms || 0) || String(a.trade_id || "").localeCompare(String(b.trade_id || ""));
  buys.sort(sortTrades);
  for (const rows of byPosition.values()) rows.sort(sortTrades);
  for (const rows of byCandidate.values()) rows.sort(sortTrades);
  return { byPosition, byCandidate, buys };
}

function latestSignalForToken(signalSnapshots, contractAddress, referenceTs) {
  const addr = cleanAddress(contractAddress);
  if (!addr) return null;
  const referenceMs = optionalMs(referenceTs) ?? Number.POSITIVE_INFINITY;
  let best = null;
  for (const event of signalSnapshots) {
    const eventMs = optionalMs(event.ts);
    if (eventMs == null || eventMs > referenceMs) break;
    const signal = event.payload.signals.find((item) => cleanAddress(item?.contract_address) === addr);
    if (signal) {
      best = {
        event_id: event.event_id || null,
        ts: event.ts || null,
        signal
      };
    }
  }
  return best;
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = event?.event_id || `${event?.event_type}:${event?.ts}:${event?.candidate_id || ""}:${event?.trade_id || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || String(a.event_id || "").localeCompare(String(b.event_id || "")));
}

function relatedEventsForClosedTrade(trade, eventIndex) {
  const candidateKey = cleanAddress(trade?.candidate_id || trade?.contract_address);
  const positionKey = trade?.position_id ? normalizeKey(trade.position_id) : null;
  const tradeKey = trade?.trade_id ? normalizeKey(trade.trade_id) : null;
  const events = [
    ...(candidateKey ? (eventIndex.byCandidate.get(candidateKey) || []) : []),
    ...(positionKey ? (eventIndex.byPosition.get(positionKey) || []) : []),
    ...(tradeKey ? (eventIndex.byTrade.get(tradeKey) || []) : [])
  ];
  return dedupeEvents(events);
}

function latestEvent(events, predicate) {
  return [...events].reverse().find(predicate) || null;
}

function storyTypesFromReviewOrProposal(review, proposal) {
  const reviewLabels = Array.isArray(review?.story_signal_labels) ? review.story_signal_labels : [];
  if (reviewLabels.length) return [...new Set(reviewLabels.map((label) => normalizeKey(label)).filter(Boolean))];
  const evidence = Array.isArray(proposal?.evidence) ? proposal.evidence : [];
  return [...new Set(evidence
    .map((item) => typeof item === "object" ? normalizeKey(item.type || item.story_type || item.category, "") : "")
    .filter(Boolean))];
}

function signalReasonSet(signal) {
  if (!signal) return ["unknown"];
  const positive = Array.isArray(signal?.positive_reasons) ? signal.positive_reasons.map((item) => `pos:${normalizeKey(item)}`) : [];
  const negative = Array.isArray(signal?.negative_reasons) ? signal.negative_reasons.map((item) => `neg:${normalizeKey(item)}`) : [];
  const missing = Array.isArray(signal?.missing_sources) ? signal.missing_sources.map((item) => `missing:${normalizeKey(item)}`) : [];
  const values = [...positive, ...negative, ...missing].sort();
  return values.length ? values : ["none"];
}

function exitSignalSet(closeTrade, review) {
  const values = [
    `exit:${normalizeKey(review?.evidence?.exit_reason || reasonRoot(closeTrade?.reason))}`,
    `lifecycle:${normalizeKey(closeTrade?.trade_lifecycle)}`
  ];
  const riskCodes = Array.isArray(review?.evidence?.risk_reason_codes) ? review.evidence.risk_reason_codes : [];
  for (const code of riskCodes) values.push(`risk:${normalizeKey(code)}`);
  return [...new Set(values)].sort();
}

function totalFeeUsd(...records) {
  return round(records.reduce((sum, record) => {
    const execution = record?.simulated_execution || record?.order_lifecycle?.simulated_execution || null;
    return sum + toNum(execution?.fee_usd, 0);
  }, 0), 2);
}

function totalSlippageUsd(...records) {
  return round(records.reduce((sum, record) => {
    const execution = record?.simulated_execution || record?.order_lifecycle?.simulated_execution || null;
    return sum + toNum(execution?.slippage_usd, 0);
  }, 0), 2);
}

function buildTradeAttributionRows(portfolio, eventIndex, reviewMap) {
  const actionIndex = buildActionIndex(portfolio?.action_history || []);
  const closedTrades = (Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .map((trade) => ({ ...trade, ts_ms: optionalMs(trade.ts) }))
    .filter((trade) => trade.ts_ms != null)
    .sort((a, b) => a.ts_ms - b.ts_ms || String(a.trade_id || "").localeCompare(String(b.trade_id || "")));

  return closedTrades.map((closeTrade) => {
    const relatedEvents = relatedEventsForClosedTrade(closeTrade, eventIndex);
    const riskEvent = latestEvent(relatedEvents, (event) => event.event_type === "risk_decision");
    const executorEvent = latestEvent(relatedEvents, (event) => event.event_type === "executor_decision");
    const proposal = riskEvent?.payload?.proposal || executorEvent?.payload?.proposal?.candidate || executorEvent?.payload?.candidate || null;
    const review = reviewMap.get(closeTrade.trade_id) || null;
    const positionBuys = closeTrade.position_id ? (actionIndex.byPosition.get(normalizeKey(closeTrade.position_id)) || []) : [];
    const candidateBuys = cleanAddress(closeTrade.candidate_id || closeTrade.contract_address)
      ? (actionIndex.byCandidate.get(cleanAddress(closeTrade.candidate_id || closeTrade.contract_address)) || [])
      : [];
    const openTrade = [...positionBuys, ...candidateBuys]
      .filter((trade, index, arr) => arr.findIndex((item) => item.trade_id === trade.trade_id) === index)
      .filter((trade) => trade.ts_ms != null && trade.ts_ms <= closeTrade.ts_ms)
      .sort((a, b) => b.ts_ms - a.ts_ms || String(b.trade_id || "").localeCompare(String(a.trade_id || "")))[0] || null;
    const signalMatch = latestSignalForToken(
      eventIndex.signalSnapshots,
      closeTrade.contract_address || openTrade?.contract_address || proposal?.token?.contract_address,
      openTrade?.ts || closeTrade.ts
    );
    const matchedSignal = signalMatch?.signal || null;
    const riskReasonCodes = Array.isArray(riskEvent?.payload?.risk_review?.reason_codes)
      ? riskEvent.payload.risk_review.reason_codes
      : Array.isArray(review?.evidence?.risk_reason_codes)
        ? review.evidence.risk_reason_codes
        : [];
    const strategyVersion = normalizeKey(
      openTrade?.strategy_version
      || closeTrade?.strategy_version
      || openTrade?.order_lifecycle?.strategy_version
      || proposal?.strategy_version,
      "unknown"
    );
    const sourceAgent = normalizeKey(
      proposal?.source_agent
      || openTrade?.paper_trade_ticket?.source_agent
      || (review?.primary_success_agent === "harvest" ? "harvest" : null),
      "unknown"
    );
    const setupType = normalizeKey(proposal?.setup_type || review?.setup_label || reasonRoot(openTrade?.reason || closeTrade.reason));
    const orderLifecycle = openTrade?.order_lifecycle || closeTrade?.order_lifecycle || null;
    const execution = closeTrade?.simulated_execution || openTrade?.simulated_execution || orderLifecycle?.simulated_execution || null;
    const approvedSizePct = toNum(
      openTrade?.paper_trade_ticket?.approved_size_pct,
      toNum(riskEvent?.payload?.risk_review?.approved_size_pct, NaN)
    );
    const sizingDecision = Number.isFinite(approvedSizePct) ? `approved_size_pct:${round(approvedSizePct, 4)}` : "approved_size_pct:unknown";
    const executionDecision = normalizeKey(
      execution?.decision
      || orderLifecycle?.current_state
      || openTrade?.paper_trade_ticket?.executor_decision
      || executorEvent?.payload?.decision,
      "unknown"
    );
    const pnlUsd = round(toNum(closeTrade.pnl_usd, 0), 2);
    const costBasisUsd = round(toNum(closeTrade.cost_portion_usd, toNum(closeTrade.cost_usd, toNum(openTrade?.cost_usd, 0))), 2);
    const feeUsd = totalFeeUsd(openTrade, closeTrade);
    const slippageUsd = totalSlippageUsd(openTrade, closeTrade);
    const storyTypes = storyTypesFromReviewOrProposal(review, proposal);
    const entrySignalSet = signalReasonSet(matchedSignal);
    const exitSignals = exitSignalSet(closeTrade, review);
    const riskCodeSet = riskReasonCodes.length ? [...new Set(riskReasonCodes.map((code) => normalizeKey(code)))].sort() : ["none"];
    const signalSnapshotId = signalMatch
      ? `sigsnap_${sha256(`${signalMatch.event_id || ""}:${cleanAddress(closeTrade.contract_address) || ""}`).slice(0, 16)}`
      : null;

    return {
      row_type: "realized_trade",
      row_id: `attr_${sha256(stableStringify({
        trade_id: closeTrade.trade_id,
        open_trade_id: openTrade?.trade_id || null,
        position_id: closeTrade.position_id || null
      })).slice(0, 24)}`,
      scope: "paper_portfolio",
      trade_id: closeTrade.trade_id || null,
      open_trade_id: openTrade?.trade_id || null,
      position_id: closeTrade.position_id || null,
      candidate_id: closeTrade.candidate_id || openTrade?.candidate_id || closeTrade.contract_address || null,
      order_id: orderLifecycle?.order_id || null,
      order_state: normalizeKey(orderLifecycle?.current_state, "unknown"),
      strategy_version: strategyVersion,
      setup_type: setupType,
      story_types: storyTypes.length ? storyTypes : ["unknown"],
      source_agent: sourceAgent,
      symbol: normalizeKey(closeTrade.symbol || openTrade?.symbol || proposal?.token?.symbol),
      token: normalizeKey(closeTrade.symbol || openTrade?.symbol || proposal?.token?.symbol),
      contract_address: cleanAddress(closeTrade.contract_address || openTrade?.contract_address || proposal?.token?.contract_address),
      category: normalizeKey(closeTrade.category || proposal?.token?.category),
      market_regime: normalizeKey(review?.market_regime_label || closeTrade.market_regime || riskEvent?.market_regime || executorEvent?.market_regime),
      liquidity_bucket: liquidityBucketForTrade(openTrade, closeTrade, riskEvent),
      risk_decision: normalizeKey(riskEvent?.payload?.risk_review?.decision || riskEvent?.payload?.decision),
      risk_reason_codes: riskCodeSet,
      sizing_decision: sizingDecision,
      execution_decision: executionDecision,
      signal_snapshot_id: signalSnapshotId,
      signal_snapshot_generated_at: signalMatch?.ts || null,
      entry_signal_set: entrySignalSet,
      exit_signal_set: exitSignals,
      win: pnlUsd > 0,
      loss: pnlUsd < 0,
      neutral: pnlUsd === 0,
      reviewed: Boolean(review),
      training_label: normalizeKey(review?.training_label, pnlUsd > 0 ? "positive" : pnlUsd < 0 ? "negative" : "neutral"),
      pnl_usd: pnlUsd,
      return_pct: costBasisUsd > 0 ? pct(pnlUsd / costBasisUsd) : null,
      fee_drag_usd: feeUsd,
      slippage_drag_usd: slippageUsd,
      fee_slippage_drag_usd: round(feeUsd + slippageUsd, 2),
      cost_basis_usd: costBasisUsd,
      proceeds_usd: round(toNum(closeTrade.proceeds_usd, 0), 2),
      opened_at: openTrade?.ts || closeTrade.opened_at || null,
      closed_at: closeTrade.ts || null,
      reason: normalizeKey(closeTrade.reason),
      review_ref: review ? { trade_id: review.trade_id, reviewed_at: review.reviewed_at || null } : null
    };
  });
}

function buildDecisionRows(eventIndex, actionIndex) {
  const rows = [];
  for (const bundle of eventIndex.candidates) {
    const candidateEvent = bundle.candidate;
    const riskEvent = bundle.risk;
    const executorEvent = bundle.executor;
    const candidate = candidateEvent?.payload || {};
    const token = candidate.token || {};
    const candidateId = cleanAddress(candidateEvent?.candidate_id || candidate.candidate_id || token.contract_address);
    const actionMatches = candidateId ? (actionIndex.byCandidate.get(candidateId) || []) : [];
    const candidateTsMs = optionalMs(candidateEvent.ts);
    const traded = actionMatches.find((trade) => trade.ts_ms != null && candidateTsMs != null && trade.ts_ms >= candidateTsMs);
    const riskDecision = normalizeKey(riskEvent?.payload?.risk_review?.decision || riskEvent?.payload?.decision, "not_reviewed");
    const executorDecision = normalizeKey(executorEvent?.payload?.decision, "not_executed");
    const allowedByRisk = riskDecision === "paper_trade" || riskDecision === "approve" || Boolean(riskEvent?.payload?.handoff_to_executor);
    const missedOpportunity = !traded && allowedByRisk;
    const decisionOutcome = traded
      ? "traded"
      : allowedByRisk
        ? "missed_opportunity"
        : riskEvent
          ? "blocked_before_trade"
          : executorEvent
            ? "executor_no_trade"
            : "no_trade";
    const reasonCodes = Array.isArray(riskEvent?.payload?.risk_review?.reason_codes)
      ? [...new Set(riskEvent.payload.risk_review.reason_codes.map((code) => normalizeKey(code)))].sort()
      : ["none"];
    rows.push({
      row_type: "candidate_decision",
      row_id: `cand_${sha256(stableStringify({
        pipeline_run_id: candidateEvent?.pipeline_run_id || null,
        cycle_id: candidateEvent?.cycle_id || null,
        candidate_id: candidateId,
        ts: candidateEvent?.ts || null
      })).slice(0, 24)}`,
      scope: "paper_pipeline",
      candidate_event_id: candidateEvent?.event_id || null,
      candidate_id: candidateId,
      trade_id: traded?.trade_id || null,
      position_id: traded?.position_id || null,
      strategy_version: normalizeKey(traded?.strategy_version || riskEvent?.payload?.proposal?.strategy_version, "unknown"),
      setup_type: normalizeKey(riskEvent?.payload?.proposal?.setup_type || candidate.setup_type || "unknown"),
      source_agent: normalizeKey(riskEvent?.payload?.proposal?.source_agent || candidateEvent?.actor || "unknown"),
      symbol: normalizeKey(token.symbol),
      token: normalizeKey(token.symbol),
      contract_address: cleanAddress(token.contract_address),
      category: normalizeKey(token.category),
      market_regime: normalizeKey(candidateEvent?.market_regime || candidate?.portfolio_snapshot?.market_regime),
      liquidity_bucket: liquidityBucketForTrade(
        traded || {},
        {},
        riskEvent || { payload: { proposal: { liquidity_data: candidate.liquidity_data || null } } }
      ),
      risk_decision: riskDecision,
      risk_reason_codes: reasonCodes,
      sizing_decision: Number.isFinite(toNum(riskEvent?.payload?.risk_review?.approved_size_pct, NaN))
        ? `approved_size_pct:${round(toNum(riskEvent.payload.risk_review.approved_size_pct, 0), 4)}`
        : "approved_size_pct:unknown",
      execution_decision: executorDecision,
      signal_snapshot_id: null,
      entry_signal_set: ["pending_signal_snapshot_lookup"],
      exit_signal_set: ["no_trade"],
      decision_outcome: decisionOutcome,
      no_trade: !traded,
      missed_opportunity: missedOpportunity,
      traded: Boolean(traded),
      ts: candidateEvent?.ts || null
    });
  }

  return rows.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || a.row_id.localeCompare(b.row_id));
}

function buildReplayRows(backtestReport) {
  const fills = Array.isArray(backtestReport?.replay?.simulated_fills) ? backtestReport.replay.simulated_fills : [];
  return fills.map((event) => {
    const order = event?.order || {};
    const execution = event?.simulated_execution || event?.fill?.execution || {};
    const riskDecision = event?.risk_decision || {};
    const riskReasonCodes = Array.isArray(riskDecision?.checked_limits)
      ? riskDecision.checked_limits
        .filter((item) => item?.status === "block" || item?.status === "warn")
        .map((item) => normalizeKey(item.code))
      : Array.isArray(riskDecision?.blockers)
        ? riskDecision.blockers.map((item) => normalizeKey(item))
        : [];
    const context = order.context || {};
    const entrySignals = event?.market_data_quality?.warnings?.length
      ? event.market_data_quality.warnings.map((item) => `warn:${normalizeKey(item)}`)
      : ["none"];
    const pnlUsd = round(toNum(event?.fill?.realized_pnl_usd, 0), 2);
    return {
      row_type: "replay_fill",
      row_id: `replay_${sha256(stableStringify({
        report_id: backtestReport?.report_id || null,
        order_id: event?.order_id || null,
        source_trade_id: event?.source_trade_id || null
      })).slice(0, 24)}`,
      scope: "latest_backtest",
      trade_id: event?.fill?.trade_id || event?.source_trade_id || null,
      open_trade_id: event?.source_trade_id || null,
      position_id: null,
      candidate_id: event?.contract_address || null,
      order_id: event?.order_id || null,
      order_state: normalizeKey(order.current_state),
      strategy_version: normalizeKey(backtestReport?.strategy_version),
      setup_type: normalizeKey(event?.fill?.fill_context?.setup_type || event?.reason || "unknown"),
      story_types: ["backtest_replay"],
      source_agent: normalizeKey(event?.fill?.fill_context?.source_agent || "replay"),
      symbol: normalizeKey(event?.symbol),
      token: normalizeKey(event?.symbol),
      contract_address: cleanAddress(event?.contract_address),
      category: normalizeKey(event?.fill?.fill_context?.category),
      market_regime: normalizeKey(event?.fill?.fill_context?.market_regime || "research"),
      liquidity_bucket: normalizeKey(execution?.liquidity_bucket),
      risk_decision: normalizeKey(riskDecision?.decision),
      risk_reason_codes: riskReasonCodes.length ? [...new Set(riskReasonCodes)].sort() : ["none"],
      sizing_decision: Number.isFinite(toNum(order?.sizing_decision_ref?.approved_size_pct, NaN))
        ? `approved_size_pct:${round(toNum(order.sizing_decision_ref.approved_size_pct, 0), 4)}`
        : "approved_size_pct:unknown",
      execution_decision: normalizeKey(execution?.decision),
      signal_snapshot_id: order.signal_snapshot_ref?.event_id || context.signal_snapshot_id || null,
      signal_snapshot_generated_at: order.signal_snapshot_ref?.generated_at || null,
      entry_signal_set: [...new Set(entrySignals)].sort(),
      exit_signal_set: [`decision:${normalizeKey(execution?.decision)}`],
      win: pnlUsd > 0,
      loss: pnlUsd < 0,
      neutral: pnlUsd === 0,
      reviewed: false,
      training_label: pnlUsd > 0 ? "positive" : pnlUsd < 0 ? "negative" : "neutral",
      pnl_usd: pnlUsd,
      return_pct: null,
      fee_drag_usd: round(toNum(execution?.fee_usd, 0), 2),
      slippage_drag_usd: round(toNum(execution?.slippage_usd, 0), 2),
      fee_slippage_drag_usd: round(toNum(execution?.fee_usd, 0) + toNum(execution?.slippage_usd, 0), 2),
      cost_basis_usd: round(toNum(execution?.filled_notional_usd, toNum(execution?.requested_notional_usd, 0)), 2),
      proceeds_usd: null,
      opened_at: event?.ts || null,
      closed_at: event?.ts || null,
      reason: normalizeKey(event?.reason),
      review_ref: null
    };
  }).sort((a, b) => String(a.opened_at || "").localeCompare(String(b.opened_at || "")) || a.row_id.localeCompare(b.row_id));
}

function buildGroupStats(groupIdBasis, rows, dimension, key, scope) {
  const pnlValues = rows.map((row) => toNum(row.pnl_usd, 0));
  const wins = rows.filter((row) => row.win);
  const losses = rows.filter((row) => row.loss);
  const grossProfit = wins.reduce((sum, row) => sum + toNum(row.pnl_usd, 0), 0);
  const grossLoss = losses.reduce((sum, row) => sum + toNum(row.pnl_usd, 0), 0);
  const feeDrag = rows.reduce((sum, row) => sum + toNum(row.fee_drag_usd, 0), 0);
  const slippageDrag = rows.reduce((sum, row) => sum + toNum(row.slippage_drag_usd, 0), 0);
  const totalPnl = pnlValues.reduce((sum, value) => sum + value, 0);
  const totalAbsPnl = rows.reduce((sum, row) => sum + Math.abs(toNum(row.pnl_usd, 0)), 0);
  const topContribution = rows
    .map((row) => ({ row_id: row.row_id, abs_pnl_usd: Math.abs(toNum(row.pnl_usd, 0)) }))
    .sort((a, b) => b.abs_pnl_usd - a.abs_pnl_usd || a.row_id.localeCompare(b.row_id))[0] || null;
  const sampleSize = rows.length;
  const winRatePct = sampleSize ? pct(wins.length / sampleSize) : 0;
  const expectancyUsd = round(average(pnlValues) ?? 0, 2);
  const confidenceWarnings = [];
  if (sampleSize < DEFAULT_MIN_CONFIDENCE_SAMPLE) confidenceWarnings.push("low_sample_size");
  if (sampleSize > 0 && rows.filter((row) => row.neutral).length / sampleSize >= 0.4) confidenceWarnings.push("high_neutral_share");
  if (totalAbsPnl > 0 && topContribution && topContribution.abs_pnl_usd / totalAbsPnl >= 0.6) confidenceWarnings.push("one_trade_concentration");
  if (grossProfit > 0 && feeDrag + slippageDrag > grossProfit) confidenceWarnings.push("cost_drag_exceeds_gross_profit");
  if (winRatePct > 50 && expectancyUsd <= 0) confidenceWarnings.push("high_win_rate_negative_expectancy");

  return {
    group_id: `siggrp_${sha256(stableStringify(groupIdBasis)).slice(0, 20)}`,
    scope,
    dimension,
    key,
    sample_size: sampleSize,
    reviewed_count: rows.filter((row) => row.reviewed).length,
    win_count: wins.length,
    loss_count: losses.length,
    neutral_count: rows.filter((row) => row.neutral).length,
    win_rate_pct: winRatePct,
    expectancy_usd: expectancyUsd,
    realized_pnl_usd: round(totalPnl, 2),
    gross_profit_usd: round(grossProfit, 2),
    gross_loss_usd: round(grossLoss, 2),
    profit_factor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 4) : (grossProfit > 0 ? null : 0),
    average_win_usd: round(average(wins.map((row) => toNum(row.pnl_usd, 0))) ?? 0, 2),
    average_loss_usd: round(average(losses.map((row) => toNum(row.pnl_usd, 0))) ?? 0, 2),
    average_return_pct: round(average(rows.map((row) => row.return_pct)) ?? 0, 4),
    fee_drag_usd: round(feeDrag, 2),
    slippage_drag_usd: round(slippageDrag, 2),
    fee_slippage_drag_usd: round(feeDrag + slippageDrag, 2),
    top_trade_contribution_pct: totalAbsPnl > 0 && topContribution ? pct(topContribution.abs_pnl_usd / totalAbsPnl) : 0,
    confidence_warnings: confidenceWarnings,
    negative_expectancy: sampleSize >= NEGATIVE_EXPECTANCY_MIN_SAMPLE && expectancyUsd <= 0,
    trade_refs: rows
      .map((row) => ({
        row_id: row.row_id,
        trade_id: row.trade_id || null,
        order_id: row.order_id || null,
        pnl_usd: round(toNum(row.pnl_usd, 0), 2)
      }))
      .sort((a, b) => b.pnl_usd - a.pnl_usd || String(a.row_id).localeCompare(String(b.row_id)))
      .slice(0, 10)
  };
}

function buildGrouping(rows, dimension, extractor) {
  const groups = new Map();
  for (const row of rows) {
    const values = extractor(row)
      .map((value) => normalizeKey(value))
      .filter(Boolean);
    for (const key of [...new Set(values)].sort()) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => buildGroupStats({ dimension, key, scope: groupRows[0]?.scope || "unknown" }, groupRows, dimension, key, groupRows[0]?.scope || "unknown"))
    .sort((a, b) => {
      if (b.sample_size !== a.sample_size) return b.sample_size - a.sample_size;
      if (b.expectancy_usd !== a.expectancy_usd) return b.expectancy_usd - a.expectancy_usd;
      return a.key.localeCompare(b.key);
    });
}

function buildTradeGroupingSet(rows) {
  return {
    by_setup: buildGrouping(rows, "setup_type", (row) => [row.setup_type]),
    by_token: buildGrouping(rows, "token", (row) => [row.token]),
    by_category: buildGrouping(rows, "category", (row) => [row.category]),
    by_source_agent: buildGrouping(rows, "source_agent", (row) => [row.source_agent]),
    by_story_type: buildGrouping(rows, "story_type", (row) => row.story_types || ["unknown"]),
    by_liquidity_bucket: buildGrouping(rows, "liquidity_bucket", (row) => [row.liquidity_bucket]),
    by_market_regime: buildGrouping(rows, "market_regime", (row) => [row.market_regime]),
    by_reason_code: buildGrouping(rows, "reason_code", (row) => row.risk_reason_codes || ["none"]),
    by_signal_snapshot: buildGrouping(rows, "signal_snapshot", (row) => [row.signal_snapshot_id || "none"]),
    by_entry_signal: buildGrouping(rows, "entry_signal", (row) => row.entry_signal_set || ["unknown"]),
    by_exit_signal: buildGrouping(rows, "exit_signal", (row) => row.exit_signal_set || ["unknown"]),
    by_risk_decision: buildGrouping(rows, "risk_decision", (row) => [row.risk_decision]),
    by_sizing_decision: buildGrouping(rows, "sizing_decision", (row) => [row.sizing_decision]),
    by_execution_decision: buildGrouping(rows, "execution_decision", (row) => [row.execution_decision]),
    by_strategy_version: buildGrouping(rows, "strategy_version", (row) => [row.strategy_version])
  };
}

function buildDecisionSummary(rows) {
  const total = rows.length;
  const counts = rows.reduce((acc, row) => {
    acc[row.decision_outcome] = (acc[row.decision_outcome] || 0) + 1;
    return acc;
  }, {});
  const bySetup = buildGrouping(rows, "setup_type", (row) => [row.setup_type]).map((group) => ({
    group_id: group.group_id,
    key: group.key,
    sample_size: group.sample_size,
    missed_opportunity_count: rows.filter((row) => row.setup_type === group.key && row.missed_opportunity).length,
    no_trade_count: rows.filter((row) => row.setup_type === group.key && row.no_trade).length
  }));
  const byRiskDecision = buildGrouping(rows, "risk_decision", (row) => [row.risk_decision]).map((group) => ({
    group_id: group.group_id,
    key: group.key,
    sample_size: group.sample_size,
    missed_opportunity_count: rows.filter((row) => row.risk_decision === group.key && row.missed_opportunity).length,
    no_trade_count: rows.filter((row) => row.risk_decision === group.key && row.no_trade).length
  }));
  return {
    candidate_count: total,
    traded_count: counts.traded || 0,
    no_trade_count: total - (counts.traded || 0),
    missed_opportunity_count: rows.filter((row) => row.missed_opportunity).length,
    outcomes: Object.keys(counts).sort().map((key) => ({ key, count: counts[key] })),
    by_setup: bySetup.sort((a, b) => b.sample_size - a.sample_size || a.key.localeCompare(b.key)),
    by_risk_decision: byRiskDecision.sort((a, b) => b.sample_size - a.sample_size || a.key.localeCompare(b.key))
  };
}

function summarizeLatestPerformance(report) {
  if (!report) return null;
  const metrics = report?.windows?.["24h"]?.metrics || {};
  return {
    report_id: report.report_id || null,
    generated_at: report.generated_at || null,
    closed_trade_count: metrics.closed_trade_count || 0,
    win_rate: metrics.win_rate || 0,
    realized_pnl_usd: metrics.realized_pnl_usd || 0,
    profit_factor: metrics.profit_factor ?? null,
    report_file: report.report_file || null
  };
}

function summarizeLatestPromotion(report) {
  if (!report) return null;
  return {
    report_id: report.report_id || null,
    generated_at: report.generated_at || null,
    strategy_version: report.strategy_version || null,
    target_state: report.target_state || null,
    promotion_decision: report.promotion_decision || null,
    expectancy_usd: report?.evidence?.performance?.expectancy_usd ?? null,
    profit_factor: report?.evidence?.performance?.profit_factor ?? null,
    report_file: report.report_file || null
  };
}

function summarizeLatestBacktest(report) {
  if (!report) return null;
  return {
    report_id: report.report_id || null,
    generated_at: report.generated_at || null,
    strategy_version: report.strategy_version || null,
    total_return_pct: report?.metrics?.total_return_pct ?? null,
    realized_pnl_usd: report?.metrics?.realized_pnl_usd ?? null,
    profit_factor: report?.metrics?.profit_factor ?? null,
    fee_slippage_drag_usd: report?.metrics?.fee_slippage_drag_usd ?? null,
    report_file: report.report_file || null
  };
}

function topGroups(groups, predicate, limit = 10) {
  return groups
    .filter(predicate)
    .slice()
    .sort((a, b) => {
      if (b.expectancy_usd !== a.expectancy_usd) return b.expectancy_usd - a.expectancy_usd;
      if (b.sample_size !== a.sample_size) return b.sample_size - a.sample_size;
      return a.key.localeCompare(b.key);
    })
    .slice(0, limit);
}

function flattenGroupings(groupings) {
  return Object.values(groupings).flat();
}

function buildSummary(tradeRows, decisionRows, groupings) {
  const sampleSize = tradeRows.length;
  const realizedPnlUsd = round(tradeRows.reduce((sum, row) => sum + toNum(row.pnl_usd, 0), 0), 2);
  const feeDragUsd = round(tradeRows.reduce((sum, row) => sum + toNum(row.fee_drag_usd, 0), 0), 2);
  const slippageDragUsd = round(tradeRows.reduce((sum, row) => sum + toNum(row.slippage_drag_usd, 0), 0), 2);
  const wins = tradeRows.filter((row) => row.win).length;
  const losses = tradeRows.filter((row) => row.loss).length;
  const expectancyUsd = round(average(tradeRows.map((row) => toNum(row.pnl_usd, 0))) ?? 0, 2);
  const allGroups = flattenGroupings(groupings);
  const negativeGroups = allGroups
    .filter((group) => group.negative_expectancy)
    .sort((a, b) => a.expectancy_usd - b.expectancy_usd || b.sample_size - a.sample_size || a.dimension.localeCompare(b.dimension))
    .slice(0, 25);

  return {
    realized_trade_count: sampleSize,
    reviewed_trade_count: tradeRows.filter((row) => row.reviewed).length,
    win_count: wins,
    loss_count: losses,
    neutral_count: tradeRows.filter((row) => row.neutral).length,
    win_rate_pct: sampleSize ? pct(wins / sampleSize) : 0,
    expectancy_usd: expectancyUsd,
    realized_pnl_usd: realizedPnlUsd,
    fee_drag_usd: feeDragUsd,
    slippage_drag_usd: slippageDragUsd,
    fee_slippage_drag_usd: round(feeDragUsd + slippageDragUsd, 2),
    no_trade_decision_count: decisionRows.filter((row) => row.no_trade).length,
    missed_opportunity_count: decisionRows.filter((row) => row.missed_opportunity).length,
    negative_expectancy_group_count: negativeGroups.length,
    top_positive_setups: topGroups(groupings.by_setup || [], (group) => group.sample_size >= NEGATIVE_EXPECTANCY_MIN_SAMPLE && group.expectancy_usd > 0, 5),
    top_negative_setups: [...(groupings.by_setup || [])]
      .filter((group) => group.sample_size >= NEGATIVE_EXPECTANCY_MIN_SAMPLE && group.expectancy_usd <= 0)
      .sort((a, b) => a.expectancy_usd - b.expectancy_usd || b.sample_size - a.sample_size || a.key.localeCompare(b.key))
      .slice(0, 5),
    confidence_warnings: [...new Set(allGroups.flatMap((group) => group.confidence_warnings))].sort()
  };
}

function markdownReport(report) {
  const lines = [
    `# Signal Attribution and Expectancy - ${report.report_id}`,
    "",
    `Generated: ${report.generated_at}`,
    `Schema version: ${report.schema_version}`,
    `Report file: ${report.report_file}`,
    "",
    "## Summary",
    "",
    `- Realized trades: ${report.summary.realized_trade_count}`,
    `- Reviewed trades: ${report.summary.reviewed_trade_count}`,
    `- No-trade decisions: ${report.summary.no_trade_decision_count}`,
    `- Missed opportunities: ${report.summary.missed_opportunity_count}`,
    `- Win rate: ${report.summary.win_rate_pct}%`,
    `- Expectancy: $${report.summary.expectancy_usd}`,
    `- Realized PnL: $${report.summary.realized_pnl_usd}`,
    `- Fee/slippage drag: $${report.summary.fee_slippage_drag_usd}`,
    "",
    "## Best Setups",
    ""
  ];

  for (const group of report.summary.top_positive_setups) {
    lines.push(`- ${group.key}: expectancy $${group.expectancy_usd}, sample ${group.sample_size}, win rate ${group.win_rate_pct}%`);
  }
  if (!report.summary.top_positive_setups.length) lines.push("- None with minimum sample yet.");

  lines.push("", "## Worst Setups", "");
  for (const group of report.summary.top_negative_setups) {
    lines.push(`- ${group.key}: expectancy $${group.expectancy_usd}, sample ${group.sample_size}, warnings ${group.confidence_warnings.join(", ") || "none"}`);
  }
  if (!report.summary.top_negative_setups.length) lines.push("- None with minimum sample yet.");

  lines.push("", "## Negative Expectancy Groups", "");
  for (const group of report.negative_expectancy_groups.slice(0, 10)) {
    lines.push(`- ${group.dimension}:${group.key} -> expectancy $${group.expectancy_usd}, sample ${group.sample_size}, fee/slippage drag $${group.fee_slippage_drag_usd}`);
  }
  if (!report.negative_expectancy_groups.length) lines.push("- None with threshold sample yet.");

  lines.push("", "## Decision Attribution", "");
  for (const item of report.decision_summary.outcomes) {
    lines.push(`- ${item.key}: ${item.count}`);
  }

  return `${lines.join("\n")}\n`;
}

export function generateSignalAttributionReport(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const portfolio = readJsonFile(options.portfolioFile || PORTFOLIO_FILE, {});
  const trainingEvents = readJsonLines(options.trainingEventLog || TRAINING_EVENT_LOG);
  const tradeReviews = readJsonLines(options.tradeReviewsLog || TRADE_REVIEWS_LOG);
  const reviewMap = new Map(tradeReviews.map((review) => [review.trade_id, review]));
  const eventIndex = buildEventIndex(trainingEvents);
  const tradeRows = buildTradeAttributionRows(portfolio, eventIndex, reviewMap);
  const actionIndex = buildActionIndex(portfolio?.action_history || []);
  const decisionRows = buildDecisionRows(eventIndex, actionIndex);
  const latestBacktestEntry = listJsonReports(BACKTEST_REPORTS_DIR, BACKTEST_REPORT_GLOB, "backtest_replay")[0] || null;
  const latestPerformanceEntry = listJsonReports(REPORTS_DIR, PERFORMANCE_REPORT_GLOB, "daily_performance")[0] || null;
  const latestPromotionEntry = listJsonReports(PROMOTION_REPORTS_DIR, PROMOTION_REPORT_GLOB, "strategy_promotion_gate")[0] || null;
  const replayRows = latestBacktestEntry?.report ? buildReplayRows(latestBacktestEntry.report) : [];
  const paperGroupings = buildTradeGroupingSet(tradeRows);
  const replayGroupings = buildTradeGroupingSet(replayRows);
  const summary = buildSummary(tradeRows, decisionRows, paperGroupings);
  const latestPerformance = summarizeLatestPerformance(latestPerformanceEntry?.report || null);
  const latestPromotion = summarizeLatestPromotion(latestPromotionEntry?.report || null);
  const latestBacktest = summarizeLatestBacktest(latestBacktestEntry?.report || null);

  const inputHash = sha256(stableStringify({
    closed_trades: (portfolio?.closed_trades || []).map((trade) => ({
      trade_id: trade.trade_id || null,
      ts: trade.ts || null,
      pnl_usd: trade.pnl_usd ?? null
    })),
    trade_review_count: tradeReviews.length,
    training_event_count: trainingEvents.length,
    latest_backtest_id: latestBacktest?.report_id || null,
    latest_performance_id: latestPerformance?.report_id || null,
    latest_promotion_id: latestPromotion?.report_id || null
  }));
  const reportId = `signal-attribution-${inputHash.slice(0, 16)}`;
  const reportTimestamp = formatReportTimestamp(new Date(optionalMs(generatedAt) || Date.now()));
  const reportFile = `reports/attribution/signal-attribution-${reportTimestamp}.json`;
  const markdownFile = `reports/attribution/signal-attribution-${reportTimestamp}.md`;
  const negativeExpectancyGroups = flattenGroupings(paperGroupings)
    .filter((group) => group.negative_expectancy)
    .sort((a, b) => a.expectancy_usd - b.expectancy_usd || b.sample_size - a.sample_size || a.dimension.localeCompare(b.dimension))
    .slice(0, 50);

  const report = {
    report_id: reportId,
    report_type: "signal_attribution_expectancy",
    schema_version: SIGNAL_ATTRIBUTION_SCHEMA_VERSION,
    generated_at: generatedAt,
    input_hash: inputHash,
    report_file: reportFile,
    markdown_file: markdownFile,
    deterministic_ids: {
      report_id_basis: "sha256(portfolio.closed_trades, trade_review_count, training_event_count, latest report ids)",
      grouping_id_basis: "sha256(scope, dimension, key)"
    },
    data_sources: {
      portfolio_json: "portfolio.json",
      training_events_jsonl: "logs/training-events.jsonl",
      trade_reviews_jsonl: "logs/trade-reviews.jsonl",
      latest_backtest_report: latestBacktestEntry?.report?.report_file || null,
      latest_performance_report: latestPerformanceEntry?.report?.report_file || null,
      latest_promotion_report: latestPromotionEntry?.report?.report_file || null
    },
    safety: {
      live_trading_enabled: false,
      portfolio_json_mutated: false,
      report_generation_mode: "read_only"
    },
    summary,
    performance_context: {
      latest_daily_performance: latestPerformance,
      latest_backtest: latestBacktest,
      latest_promotion: latestPromotion
    },
    decision_summary: buildDecisionSummary(decisionRows),
    paper_trade_attribution: {
      row_count: tradeRows.length,
      rows: tradeRows,
      groupings: paperGroupings
    },
    decision_attribution: {
      row_count: decisionRows.length,
      rows: decisionRows
    },
    replay_attribution: {
      report_id: latestBacktest?.report_id || null,
      row_count: replayRows.length,
      rows: replayRows,
      groupings: replayGroupings
    },
    negative_expectancy_groups: negativeExpectancyGroups
  };

  if (options.write !== false) {
    fs.mkdirSync(ATTRIBUTION_REPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report));
  }

  return report;
}

function parseArgs(argv) {
  return {
    generatedAt: argv.find((arg) => arg.startsWith("--generated-at="))?.slice("--generated-at=".length) || null,
    write: !argv.includes("--no-write")
  };
}

if (process.argv[1] === __filename) {
  const report = generateSignalAttributionReport(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    report_id: report.report_id,
    report_file: report.report_file,
    markdown_file: report.markdown_file,
    realized_trade_count: report.summary.realized_trade_count,
    no_trade_decision_count: report.summary.no_trade_decision_count,
    missed_opportunity_count: report.summary.missed_opportunity_count,
    expectancy_usd: report.summary.expectancy_usd,
    negative_expectancy_group_count: report.summary.negative_expectancy_group_count
  }, null, 2));
}
