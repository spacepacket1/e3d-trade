import crypto from "crypto";

export const MARKET_DATA_QUALITY_SCHEMA_VERSION = "1.0";
export const MARKET_DATA_QUALITY_MODEL_VERSION = "market-data-quality-v1";

const DEFAULTS = Object.freeze({
  defaultChain: "ethereum",
  priceStaleWarnMs: 15 * 60 * 1000,
  priceStaleBlockMs: 4 * 60 * 60 * 1000,
  liquidityStaleWarnMs: 30 * 60 * 1000,
  liquidityStaleBlockMs: 6 * 60 * 60 * 1000,
  disagreementWarnBps: 75,
  disagreementBlockBps: 300,
  suspiciousVolumeToLiquidityRatio: 12,
  lowConfidenceWarn: 70,
  lowConfidenceBlock: 40
});

function toNum(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanAddress(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text || null;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function inferSource(input = {}, ...values) {
  for (const value of values) {
    const source = cleanText(value);
    if (source) return source;
  }
  return cleanText(input?.source) || "unknown";
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function qualityBucket(ageMs, warnMs, blockMs) {
  if (ageMs == null) return "unknown";
  if (ageMs >= blockMs) return "stale";
  if (ageMs >= warnMs) return "aging";
  return "fresh";
}

function pickFirstFinite(candidates) {
  for (const candidate of candidates) {
    if (Number.isFinite(candidate?.value)) return candidate;
  }
  return null;
}

function gatherNumericCandidates(input = {}, specs = []) {
  return specs.map(({ key, value, source, ts, field }) => ({
    key,
    field: field || key,
    value: toNum(value, NaN),
    source: inferSource(input, source),
    ts: cleanText(ts) || null
  })).filter((candidate) => Number.isFinite(candidate.value));
}

function priceCandidates(input = {}) {
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const marketData = input?.market_data && typeof input.market_data === "object" ? input.market_data : {};
  const snapshot = input?.last_market_snapshot && typeof input.last_market_snapshot === "object" ? input.last_market_snapshot : {};
  const snapshotMarket = snapshot?.market_data && typeof snapshot.market_data === "object" ? snapshot.market_data : {};
  const ticket = input?.paper_trade_ticket && typeof input.paper_trade_ticket === "object" ? input.paper_trade_ticket : {};
  return gatherNumericCandidates(input, [
    { key: "market_data.current_price", value: marketData.current_price, source: marketData.price_source, ts: marketData.price_timestamp },
    { key: "market_data.price_usd", value: marketData.price_usd, source: marketData.price_source, ts: marketData.price_timestamp },
    { key: "token.current_price", value: token.current_price, source: token.price_source, ts: token.price_timestamp },
    { key: "token.price_usd", value: token.price_usd, source: token.price_source, ts: token.price_timestamp },
    { key: "input.current_price", value: input.current_price, source: input.price_source, ts: input.price_timestamp },
    { key: "input.price", value: input.price, source: input.price_source, ts: input.price_timestamp || input.ts },
    { key: "paper_trade_ticket.assumed_entry", value: ticket.assumed_entry, source: "paper_trade_ticket", ts: ticket.created_at || input.ts },
    { key: "last_market_snapshot.market_data.current_price", value: snapshotMarket.current_price, source: snapshotMarket.price_source || snapshot.source, ts: snapshotMarket.price_timestamp || snapshot.ts }
  ]);
}

function liquidityCandidates(input = {}) {
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const liquidityData = input?.liquidity_data && typeof input.liquidity_data === "object" ? input.liquidity_data : {};
  const snapshot = input?.last_market_snapshot && typeof input.last_market_snapshot === "object" ? input.last_market_snapshot : {};
  const snapshotLiquidity = snapshot?.liquidity_data && typeof snapshot.liquidity_data === "object" ? snapshot.liquidity_data : {};
  const ticket = input?.paper_trade_ticket && typeof input.paper_trade_ticket === "object" ? input.paper_trade_ticket : {};
  return gatherNumericCandidates(input, [
    { key: "liquidity_data.liquidity_usd", value: liquidityData.liquidity_usd, source: liquidityData.liquidity_source, ts: liquidityData.liquidity_timestamp },
    { key: "token.liquidity_usd", value: token.liquidity_usd, source: token.liquidity_source, ts: token.liquidity_timestamp },
    { key: "input.liquidity_usd", value: input.liquidity_usd, source: input.liquidity_source, ts: input.liquidity_timestamp || input.ts },
    { key: "paper_trade_ticket.liquidity_usd", value: ticket.liquidity_usd, source: "paper_trade_ticket", ts: ticket.created_at || input.ts },
    { key: "last_market_snapshot.liquidity_data.liquidity_usd", value: snapshotLiquidity.liquidity_usd, source: snapshotLiquidity.liquidity_source || snapshot.source, ts: snapshotLiquidity.liquidity_timestamp || snapshot.ts }
  ]);
}

function volumeCandidates(input = {}) {
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const marketData = input?.market_data && typeof input.market_data === "object" ? input.market_data : {};
  const snapshot = input?.last_market_snapshot && typeof input.last_market_snapshot === "object" ? input.last_market_snapshot : {};
  const snapshotMarket = snapshot?.market_data && typeof snapshot.market_data === "object" ? snapshot.market_data : {};
  return gatherNumericCandidates(input, [
    { key: "market_data.volume_24h_usd", value: marketData.volume_24h_usd, source: marketData.price_source, ts: marketData.price_timestamp },
    { key: "token.volume_24h_usd", value: token.volume_24h_usd, source: token.price_source, ts: token.price_timestamp },
    { key: "input.volume_24h_usd", value: input.volume_24h_usd, source: input.price_source, ts: input.price_timestamp || input.ts },
    { key: "last_market_snapshot.market_data.volume_24h_usd", value: snapshotMarket.volume_24h_usd, source: snapshotMarket.price_source || snapshot.source, ts: snapshotMarket.price_timestamp || snapshot.ts }
  ]);
}

function spreadCandidates(input = {}) {
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const executionData = input?.execution_data && typeof input.execution_data === "object" ? input.execution_data : {};
  const snapshot = input?.last_market_snapshot && typeof input.last_market_snapshot === "object" ? input.last_market_snapshot : {};
  const snapshotExecution = snapshot?.execution_data && typeof snapshot.execution_data === "object" ? snapshot.execution_data : {};
  const ticket = input?.paper_trade_ticket && typeof input.paper_trade_ticket === "object" ? input.paper_trade_ticket : {};
  return gatherNumericCandidates(input, [
    { key: "execution_data.spread_bps", value: executionData.spread_bps, source: executionData.quote_source, ts: executionData.quote_timestamp },
    { key: "token.spread_bps", value: token.spread_bps, source: token.quote_source, ts: token.quote_timestamp },
    { key: "input.spread_bps", value: input.spread_bps, source: input.quote_source, ts: input.quote_timestamp || input.ts },
    { key: "paper_trade_ticket.spread_bps", value: ticket.spread_bps, source: "paper_trade_ticket", ts: ticket.created_at || input.ts },
    { key: "last_market_snapshot.execution_data.spread_bps", value: snapshotExecution.spread_bps, source: snapshotExecution.quote_source || snapshot.source, ts: snapshotExecution.quote_timestamp || snapshot.ts }
  ]);
}

function slippageCandidates(input = {}) {
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const executionData = input?.execution_data && typeof input.execution_data === "object" ? input.execution_data : {};
  const snapshot = input?.last_market_snapshot && typeof input.last_market_snapshot === "object" ? input.last_market_snapshot : {};
  const snapshotExecution = snapshot?.execution_data && typeof snapshot.execution_data === "object" ? snapshot.execution_data : {};
  const ticket = input?.paper_trade_ticket && typeof input.paper_trade_ticket === "object" ? input.paper_trade_ticket : {};
  return gatherNumericCandidates(input, [
    { key: "execution_data.estimated_slippage_bps", value: executionData.estimated_slippage_bps, source: executionData.quote_source, ts: executionData.quote_timestamp },
    { key: "token.slippage_bps", value: token.slippage_bps, source: token.quote_source, ts: token.quote_timestamp },
    { key: "input.slippage_bps", value: input.slippage_bps, source: input.quote_source, ts: input.quote_timestamp || input.ts },
    { key: "paper_trade_ticket.max_slippage_bps", value: ticket.max_slippage_bps, source: "paper_trade_ticket", ts: ticket.created_at || input.ts },
    { key: "last_market_snapshot.execution_data.estimated_slippage_bps", value: snapshotExecution.estimated_slippage_bps, source: snapshotExecution.quote_source || snapshot.source, ts: snapshotExecution.quote_timestamp || snapshot.ts }
  ]);
}

function disagreementBps(candidates) {
  const values = candidates.map((candidate) => candidate.value).filter(Number.isFinite);
  const pivot = median(values);
  if (!(pivot > 0) || values.length < 2) return 0;
  return round(((Math.max(...values) - Math.min(...values)) / pivot) * 10000, 4) || 0;
}

function collectSources(...candidateSets) {
  return [...new Set(candidateSets.flat().map((candidate) => candidate.source).filter(Boolean))].sort();
}

export function buildMarketDataQuality(input = {}, options = {}) {
  const evaluationTs = cleanText(options.evaluated_at || input.evaluated_at || input.ts) || new Date().toISOString();
  const evaluationMs = optionalMs(evaluationTs);
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const priceSet = priceCandidates(input);
  const liquiditySet = liquidityCandidates(input);
  const volumeSet = volumeCandidates(input);
  const spreadSet = spreadCandidates(input);
  const slippageSet = slippageCandidates(input);
  const price = pickFirstFinite(priceSet);
  const liquidity = pickFirstFinite(liquiditySet);
  const volume = pickFirstFinite(volumeSet);
  const spread = pickFirstFinite(spreadSet);
  const slippage = pickFirstFinite(slippageSet);
  const priceTs = cleanText(price?.ts);
  const liquidityTs = cleanText(liquidity?.ts);
  const priceAgeMs = evaluationMs != null && priceTs ? Math.max(0, evaluationMs - optionalMs(priceTs)) : null;
  const liquidityAgeMs = evaluationMs != null && liquidityTs ? Math.max(0, evaluationMs - optionalMs(liquidityTs)) : null;
  const priceFreshness = qualityBucket(priceAgeMs, options.priceStaleWarnMs || DEFAULTS.priceStaleWarnMs, options.priceStaleBlockMs || DEFAULTS.priceStaleBlockMs);
  const liquidityFreshness = qualityBucket(liquidityAgeMs, options.liquidityStaleWarnMs || DEFAULTS.liquidityStaleWarnMs, options.liquidityStaleBlockMs || DEFAULTS.liquidityStaleBlockMs);
  const priceDisagreementBps = disagreementBps(priceSet);
  const warnings = [];
  const blockers = [];
  const missingFields = [];
  const apiErrors = Array.isArray(input.api_errors) ? input.api_errors.filter(Boolean).map(String) : [];

  if (!price) {
    missingFields.push("price_usd");
    blockers.push("missing_price");
  }
  if (!liquidity) {
    missingFields.push("liquidity_usd");
    blockers.push("missing_liquidity");
  }
  if (!spread) {
    missingFields.push("spread_bps");
    warnings.push("missing_spread");
  }
  if (!slippage) {
    missingFields.push("slippage_bps");
    warnings.push("missing_slippage");
  }
  if (!priceTs) {
    missingFields.push("price_timestamp");
    warnings.push("missing_price_timestamp");
  }
  if (!price?.source) {
    missingFields.push("price_source");
    warnings.push("missing_price_source");
  }
  if (!liquidity?.source) {
    missingFields.push("liquidity_source");
    warnings.push("missing_liquidity_source");
  }
  if (priceFreshness === "aging") warnings.push("price_aging");
  if (priceFreshness === "stale") blockers.push("stale_price");
  if (liquidityFreshness === "aging") warnings.push("liquidity_aging");
  if (liquidityFreshness === "stale") blockers.push("stale_liquidity");
  if (priceDisagreementBps >= (options.disagreementBlockBps || DEFAULTS.disagreementBlockBps)) blockers.push("cross_source_price_disagreement");
  else if (priceDisagreementBps >= (options.disagreementWarnBps || DEFAULTS.disagreementWarnBps)) warnings.push("cross_source_price_disagreement");

  const volumeToLiquidityRatio = price && liquidity && volume && liquidity.value > 0
    ? round(volume.value / liquidity.value, 4)
    : null;
  if (volumeToLiquidityRatio != null && volumeToLiquidityRatio >= (options.suspiciousVolumeToLiquidityRatio || DEFAULTS.suspiciousVolumeToLiquidityRatio)) {
    warnings.push("suspicious_volume_spike");
  }
  if (apiErrors.length) warnings.push("api_errors_present");

  let confidence = 100;
  confidence -= blockers.length * 30;
  confidence -= warnings.length * 8;
  if (!priceTs) confidence -= 10;
  if (!price?.source) confidence -= 5;
  if (!liquidity?.source) confidence -= 5;
  confidence = Math.max(0, Math.min(100, confidence));
  if (confidence <= (options.lowConfidenceBlock || DEFAULTS.lowConfidenceBlock)) blockers.push("low_data_confidence");
  else if (confidence <= (options.lowConfidenceWarn || DEFAULTS.lowConfidenceWarn)) warnings.push("low_data_confidence");

  const normalized = {
    chain: cleanText(input.chain || token.chain || options.defaultChain || DEFAULTS.defaultChain)?.toLowerCase() || DEFAULTS.defaultChain,
    contract_address: cleanAddress(input.contract_address || token.contract_address || token.address),
    symbol: cleanText(input.symbol || token.symbol),
    source: {
      price: price?.source || null,
      liquidity: liquidity?.source || null,
      spread: spread?.source || null,
      slippage: slippage?.source || null,
      available_sources: collectSources(priceSet, liquiditySet, spreadSet, slippageSet)
    },
    price_usd: round(price?.value, 8),
    liquidity_usd: round(liquidity?.value, 2),
    volume_24h_usd: round(volume?.value, 2),
    spread_bps: round(spread?.value, 4),
    slippage_bps: round(slippage?.value, 4),
    price_timestamp: priceTs || null,
    liquidity_timestamp: liquidityTs || null,
    price_age_ms: priceAgeMs,
    liquidity_age_ms: liquidityAgeMs,
    price_freshness: priceFreshness,
    liquidity_freshness: liquidityFreshness,
    price_disagreement_bps: round(priceDisagreementBps, 4),
    volume_to_liquidity_ratio: volumeToLiquidityRatio,
    missing_fields: [...new Set(missingFields)].sort(),
    confidence
  };

  const snapshot = {
    schema_version: MARKET_DATA_QUALITY_SCHEMA_VERSION,
    model_version: MARKET_DATA_QUALITY_MODEL_VERSION,
    evaluated_at: evaluationTs,
    normalized,
    warnings: [...new Set(warnings)].sort(),
    blockers: [...new Set(blockers)].sort(),
    degraded_data_mode: apiErrors.length > 0 || blockers.includes("missing_price") || blockers.includes("missing_liquidity"),
    api_errors: [...new Set(apiErrors)].sort()
  };

  const snapshotHash = sha256(stableStringify(snapshot));

  return {
    ...snapshot,
    snapshot_hash: snapshotHash,
    data_quality_id: `mdq_${snapshotHash.slice(0, 32)}`,
    id_basis: "sha256(schema_version,model_version,evaluated_at,normalized,warnings,blockers,degraded_data_mode,api_errors)"
  };
}

export function buildMarketDataQualityRef(snapshot = null, extras = {}) {
  if (!snapshot?.data_quality_id) return null;
  return {
    data_quality_id: snapshot.data_quality_id,
    snapshot_hash: snapshot.snapshot_hash,
    confidence: snapshot.normalized?.confidence ?? null,
    blocker_count: Array.isArray(snapshot.blockers) ? snapshot.blockers.length : 0,
    warning_count: Array.isArray(snapshot.warnings) ? snapshot.warnings.length : 0,
    price_freshness: snapshot.normalized?.price_freshness || null,
    liquidity_freshness: snapshot.normalized?.liquidity_freshness || null,
    degraded_data_mode: Boolean(snapshot.degraded_data_mode),
    context: extras.context || null
  };
}

export function summarizeMarketDataQuality(records = []) {
  const snapshots = records.filter((record) => record && typeof record === "object");
  const warningCounts = new Map();
  const blockerCounts = new Map();
  const sourceCounts = new Map();
  let degradedCount = 0;
  let staleCount = 0;

  for (const snapshot of snapshots) {
    if (snapshot.degraded_data_mode) degradedCount += 1;
    if (snapshot.normalized?.price_freshness === "stale" || snapshot.normalized?.liquidity_freshness === "stale") staleCount += 1;
    for (const code of snapshot.warnings || []) warningCounts.set(code, (warningCounts.get(code) || 0) + 1);
    for (const code of snapshot.blockers || []) blockerCounts.set(code, (blockerCounts.get(code) || 0) + 1);
    for (const source of snapshot.normalized?.source?.available_sources || []) {
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }
  }

  const confidences = snapshots.map((snapshot) => toNum(snapshot.normalized?.confidence, NaN)).filter(Number.isFinite);
  const averageConfidence = confidences.length ? round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length, 2) : null;
  const topEntries = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 8)
    .map(([code, count]) => ({ code, count }));

  return {
    snapshot_count: snapshots.length,
    degraded_count: degradedCount,
    stale_count: staleCount,
    blocker_count: snapshots.filter((snapshot) => (snapshot.blockers || []).length > 0).length,
    warning_count: snapshots.filter((snapshot) => (snapshot.warnings || []).length > 0).length,
    average_confidence: averageConfidence,
    top_warnings: topEntries(warningCounts),
    top_blockers: topEntries(blockerCounts),
    sources: topEntries(sourceCounts)
  };
}
