#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// Load repo-root .env so cron-launched runs (which do not inherit a login shell's
// environment) still see TYPESAFE_API_KEY, matching the main trading process's own loader.
try {
  const envPath = path.join(path.dirname(__filename), "..", ".env");
  const envLines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) process.env[key] = val;
  }
} catch (_) {}

const DEFAULT_THRESHOLD = 0.05;
const REQUEST_URL = "https://api.typesafe.ai/v1/systemone";
const REQUEST_TIMEOUT_MS = 10000;
const ALLOWED_CHOICES = ["candidate_count", "top_composite_score", "new_approvals", "held_position_move"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const trimToNull = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
};
const normalizeAddress = (value) => trimToNull(value)?.toLowerCase() ?? null;
const toFiniteNumber = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const parseTimestamp = (value) => {
  const text = trimToNull(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
};
const validUnit = (value, max = 1) => Number.isFinite(value) && value >= 0 && value <= max;
const validProbabilityMap = (value) => value === undefined || (isObject(value) && Object.values(value).every((entry) => validUnit(entry)));

function isDirectlyInvoked() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

export function parseCadenceArgs(argv = [], cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  const raw = {
    root: resolvedCwd,
    portfolio: null,
    pipelineLog: null,
    calibrationLog: null,
    now: null,
    threshold: null
  };
  const diagnostics = [];
  const expectsValue = new Set(["--root", "--portfolio", "--pipeline-log", "--calibration-log", "--now", "--threshold"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!expectsValue.has(flag)) {
      diagnostics.push(`unknown argument: ${flag}`);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      diagnostics.push(`missing value for ${flag}`);
      continue;
    }
    if (flag === "--root") raw.root = value;
    if (flag === "--portfolio") raw.portfolio = value;
    if (flag === "--pipeline-log") raw.pipelineLog = value;
    if (flag === "--calibration-log") raw.calibrationLog = value;
    if (flag === "--now") raw.now = value;
    if (flag === "--threshold") raw.threshold = value;
    index += 1;
  }
  const root = path.resolve(resolvedCwd, raw.root || ".");
  return {
    invalidUsage: diagnostics.length > 0,
    diagnostics,
    root,
    portfolioPath: raw.portfolio ? path.resolve(resolvedCwd, raw.portfolio) : path.join(root, "portfolio.json"),
    pipelineLogPath: raw.pipelineLog ? path.resolve(resolvedCwd, raw.pipelineLog) : path.join(root, "logs", "pipeline.jsonl"),
    calibrationLogPath: raw.calibrationLog ? path.resolve(resolvedCwd, raw.calibrationLog) : path.join(root, "logs", "jev-cycle-cadence.jsonl"),
    now: raw.now,
    thresholdRaw: raw.threshold
  };
}

export function parseCadenceThreshold({ argvValue = null, envValue = null, defaultValue = DEFAULT_THRESHOLD } = {}) {
  const raw = argvValue ?? envValue ?? defaultValue;
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return null;
  return threshold;
}

export function parseJsonlRecords(text = "") {
  const records = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push({ index, value: JSON.parse(line) });
    } catch {
      continue;
    }
  }
  return records;
}

export function normalizePortfolioHeldPositions(portfolio = {}) {
  const positions = [];
  for (const position of Object.values(isObject(portfolio?.positions) ? portfolio.positions : {})) {
    const address = normalizeAddress(position?.contract_address);
    if (!address) continue;
    positions.push({
      address,
      symbol: typeof position?.symbol === "string" ? position.symbol : "",
      current_price: null
    });
  }
  return positions;
}

const normalizeApprovedCandidates = (entries) => {
  const normalized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const address = normalizeAddress(entry?.address ?? entry?.contract_address);
    if (!address) continue;
    normalized.push({
      address,
      symbol: typeof entry?.symbol === "string" ? entry.symbol : ""
    });
  }
  return normalized;
};

const normalizeHeldPositions = (entries) => {
  const normalized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const address = normalizeAddress(entry?.address ?? entry?.contract_address);
    if (!address) continue;
    normalized.push({
      address,
      symbol: typeof entry?.symbol === "string" ? entry.symbol : "",
      current_price: toFiniteNumber(entry?.current_price)
    });
  }
  return normalized;
};

export function normalizeCadenceSnapshotRecord(record, order, portfolioFallback = []) {
  if (!isObject(record) || record.stage !== "cycle_cadence_snapshot" || !isObject(record.data)) return null;
  const cycleId = trimToNull(record.data.cycle_id);
  const completedAt = trimToNull(record.data.completed_at);
  const completedAtMs = parseTimestamp(completedAt);
  if (!cycleId || completedAtMs === null) return null;

  const approvedCandidates = normalizeApprovedCandidates(record.data.approved_candidates);
  const heldPositions = Array.isArray(record.data.held_positions)
    ? normalizeHeldPositions(record.data.held_positions)
    : portfolioFallback.map((entry) => ({ ...entry }));
  const candidateCount = Math.max(0, Math.trunc(toFiniteNumber(record.data.candidate_count) ?? 0));
  const topCompositeScore = toFiniteNumber(record.data.top_composite_score);
  const data = {
    cycle_id: cycleId,
    completed_at: completedAt,
    approved_candidates: approvedCandidates,
    held_positions: heldPositions,
    candidate_count: candidateCount,
    top_composite_score: topCompositeScore
  };
  return { order, completed_at_ms: completedAtMs, cycle_id: cycleId, data };
}

export function getLatestCadenceWindow(snapshots = []) {
  const ordered = [...snapshots].sort((left, right) => {
    if (left.completed_at_ms !== right.completed_at_ms) return left.completed_at_ms - right.completed_at_ms;
    if (left.cycle_id !== right.cycle_id) return left.cycle_id.localeCompare(right.cycle_id);
    return left.order - right.order;
  });
  return ordered.slice(-2);
}

export function calculateMeaningfulMove(absChangePct, threshold) {
  return Number.isFinite(absChangePct) && Number.isFinite(threshold) && absChangePct >= threshold;
}

export function buildCadenceDelta(previousSnapshot, currentSnapshot) {
  const previous = previousSnapshot?.data ?? null;
  const current = currentSnapshot?.data ?? null;
  if (!previous || !current) return null;

  const previousApprovedSet = new Set(previous.approved_candidates.map((entry) => entry.address));
  const newApprovedCandidates = [];
  const seenApproved = new Set();
  for (const entry of current.approved_candidates) {
    if (previousApprovedSet.has(entry.address) || seenApproved.has(entry.address)) continue;
    seenApproved.add(entry.address);
    newApprovedCandidates.push({ address: entry.address, symbol: entry.symbol });
  }

  const previousHeldByAddress = new Map(previous.held_positions.map((entry) => [entry.address, entry]));
  const heldPositionPriceChanges = [];
  let maxAbsHeldMovePct = null;
  for (const entry of current.held_positions) {
    const previousEntry = previousHeldByAddress.get(entry.address);
    if (!previousEntry) continue;
    const previousPrice = toFiniteNumber(previousEntry.current_price);
    const currentPrice = toFiniteNumber(entry.current_price);
    if (!Number.isFinite(previousPrice) || previousPrice === 0 || !Number.isFinite(currentPrice)) continue;
    const absChangePct = Math.abs(currentPrice - previousPrice) / Math.abs(previousPrice);
    heldPositionPriceChanges.push({
      address: entry.address,
      symbol: entry.symbol,
      previous_price: previousPrice,
      current_price: currentPrice,
      abs_change_pct: absChangePct
    });
    maxAbsHeldMovePct = maxAbsHeldMovePct === null ? absChangePct : Math.max(maxAbsHeldMovePct, absChangePct);
  }

  const previousTopCompositeScore = toFiniteNumber(previous.top_composite_score);
  const currentTopCompositeScore = toFiniteNumber(current.top_composite_score);
  const topCompositeScoreDelta = Number.isFinite(previousTopCompositeScore) && Number.isFinite(currentTopCompositeScore)
    ? currentTopCompositeScore - previousTopCompositeScore
    : null;

  return {
    previous_cycle_id: previous.cycle_id,
    current_cycle_id: current.cycle_id,
    previous_completed_at: previous.completed_at,
    current_completed_at: current.completed_at,
    candidate_count_delta: current.candidate_count - previous.candidate_count,
    previous_top_composite_score: previousTopCompositeScore,
    current_top_composite_score: currentTopCompositeScore,
    top_composite_score_delta: topCompositeScoreDelta,
    new_approved_candidates: newApprovedCandidates,
    held_position_price_changes: heldPositionPriceChanges,
    max_abs_held_move_pct: maxAbsHeldMovePct
  };
}

export function buildCadenceJevRequestBody({ previous, current, delta }) {
  return {
    model: "jev-latest",
    state: { previous, current, delta },
    questions: {
      run_early_cycle: {
        type: "noul",
        instructions: "Is the delta sufficient to justify an early full Scout/Harvest cycle?",
        criteria: {
          true: "Material candidate-count, top-score, approval, or held-position changes justify pulling the cycle forward.",
          false: "The delta is empty or too small to justify an early Scout/Harvest cycle."
        }
      },
      change_materiality: {
        type: "score",
        instructions: "How material is the observed change to Scout/Harvest timing?",
        criteria: [
          "No Scout/Harvest timing relevance",
          "Context only, no cadence impact",
          "Indirect research or diagnostic relevance",
          "Affects Scout/Harvest inputs but not enough to pull the cycle forward",
          "Directly warrants an early full Scout/Harvest cycle"
        ]
      },
      dominant_driver: {
        type: "choice",
        instructions: "Which observed change most strongly argues for an early cycle?",
        options: ALLOWED_CHOICES,
        criteria: {
          candidate_count: "The cognitive-state candidate count changed enough to justify an early cycle.",
          top_composite_score: "The highest finite composite score changed enough to justify an early cycle.",
          new_approvals: "Newly approved candidates relative to the previous completed cycle dominate the case for an early cycle.",
          held_position_move: "Held-position price movement dominates the case for an early cycle."
        }
      }
    }
  };
}

export function normalizeCadenceJevResponse(payload) {
  if (!isObject(payload) || !isObject(payload.answers)) return null;
  const noul = payload.answers.run_early_cycle;
  const score = payload.answers.change_materiality;
  const choice = payload.answers.dominant_driver;
  if (!isObject(noul) || !isObject(score) || !isObject(choice)) return null;
  if (noul.type !== "noul" || score.type !== "score" || choice.type !== "choice") return null;
  if (!validUnit(noul.noul) || !Number.isFinite(score.score) || score.score < 0 || score.score > 4 || !validUnit(score.confidence) || !ALLOWED_CHOICES.includes(choice.choice) || !validUnit(choice.confidence)) {
    return null;
  }
  if (!validProbabilityMap(noul.probabilities) || !validProbabilityMap(score.probabilities) || !validProbabilityMap(choice.probabilities)) {
    return null;
  }
  return {
    noul: noul.noul,
    score: score.score,
    choice: choice.choice,
    score_confidence: score.confidence,
    choice_confidence: choice.confidence
  };
}

export function associateVerdictsToInterval(records, { previousCompletedAt, currentCompletedAt }) {
  const previousMs = parseTimestamp(previousCompletedAt);
  const currentMs = parseTimestamp(currentCompletedAt);
  if (previousMs === null || currentMs === null) return [];
  const verdictIds = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!isObject(record) || record.record_type !== "shadow_verdict") continue;
    const verdictId = trimToNull(record.verdict_id);
    const observedAtMs = parseTimestamp(record.observed_at);
    if (!verdictId || observedAtMs === null) continue;
    if (observedAtMs > previousMs && observedAtMs <= currentMs) verdictIds.push(verdictId);
  }
  return verdictIds;
}

export function buildActualOutcomeIfNeeded({ calibrationRecords, currentSnapshot, previousSnapshot, delta, threshold }) {
  const currentCycleId = trimToNull(currentSnapshot?.data?.cycle_id);
  if (!currentCycleId) return null;
  const processedCycleIds = new Set();
  for (const record of Array.isArray(calibrationRecords) ? calibrationRecords : []) {
    if (!isObject(record) || record.record_type !== "actual_outcome") continue;
    const cycleId = trimToNull(record.cycle_id);
    if (cycleId) processedCycleIds.add(cycleId);
  }
  if (processedCycleIds.has(currentCycleId)) return null;

  const associatedVerdictIds = associateVerdictsToInterval(calibrationRecords, {
    previousCompletedAt: previousSnapshot.data.completed_at,
    currentCompletedAt: currentSnapshot.data.completed_at
  });
  return {
    schema_version: 1,
    record_type: "actual_outcome",
    cycle_id: currentCycleId,
    previous_cycle_id: previousSnapshot.data.cycle_id,
    completed_at: currentSnapshot.data.completed_at,
    new_approved_candidates: delta.new_approved_candidates.map((entry) => ({ ...entry })),
    meaningful_held_moves: delta.held_position_price_changes
      .filter((entry) => calculateMeaningfulMove(entry.abs_change_pct, threshold))
      .map((entry) => ({ ...entry })),
    associated_verdict_ids: associatedVerdictIds,
    meaningful_move_threshold: threshold
  };
}

function loadJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readJsonlFile(filePath) {
  try {
    return parseJsonlRecords(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function appendJsonLine(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let prefix = "";
  try {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing.length && !existing.endsWith("\n")) prefix = "\n";
  } catch {
    // file does not exist yet -- nothing to terminate
  }
  fs.appendFileSync(filePath, `${prefix}${JSON.stringify(record)}\n`);
}

async function requestCadenceJev({ key, previous, current, delta, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(REQUEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(buildCadenceJevRequestBody({ previous, current, delta })),
      signal: controller.signal
    });
    if (!response?.ok) return { attempted: true, normalized: null, reason: "http_failure" };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { attempted: true, normalized: null, reason: "invalid_response" };
    }
    const normalized = normalizeCadenceJevResponse(payload);
    return normalized
      ? { attempted: true, normalized, reason: "ok" }
      : { attempted: true, normalized: null, reason: "invalid_response" };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
    return { attempted: true, normalized: null, reason: timedOut ? "timeout" : "http_failure" };
  } finally {
    clearTimeout(timer);
  }
}

function buildShadowVerdict({ observedAt, threshold, windowSnapshots, delta, request }) {
  if (windowSnapshots.length < 2 || !delta) {
    const currentCycleId = windowSnapshots.length === 1 ? windowSnapshots[0].data.cycle_id : null;
    return {
      schema_version: 1,
      record_type: "shadow_verdict",
      mode: "shadow",
      verdict_id: crypto.randomUUID(),
      observed_at: observedAt,
      previous_cycle_id: null,
      current_cycle_id: currentCycleId,
      source_cycle_window: null,
      input_snapshot: { meaningful_move_threshold: threshold },
      jev_attempted: false,
      jev_available: false,
      noul: null,
      score: null,
      choice: null,
      score_confidence: null,
      choice_confidence: null,
      recommends_early_cycle: false,
      reason: "insufficient_history"
    };
  }

  const normalized = request.normalized;
  return {
    schema_version: 1,
    record_type: "shadow_verdict",
    mode: "shadow",
    verdict_id: crypto.randomUUID(),
    observed_at: observedAt,
    previous_cycle_id: delta.previous_cycle_id,
    current_cycle_id: delta.current_cycle_id,
    source_cycle_window: {
      previous_completed_at: delta.previous_completed_at,
      current_completed_at: delta.current_completed_at
    },
    input_snapshot: {
      ...delta,
      meaningful_move_threshold: threshold
    },
    jev_attempted: request.attempted,
    jev_available: request.reason === "ok",
    noul: normalized?.noul ?? null,
    score: normalized?.score ?? null,
    choice: normalized?.choice ?? null,
    score_confidence: normalized?.score_confidence ?? null,
    choice_confidence: normalized?.choice_confidence ?? null,
    recommends_early_cycle: Boolean(normalized && normalized.noul >= 0.5),
    reason: request.reason
  };
}

function buildStdoutResult({ verdict, actualOutcomeAppended, exitCode }) {
  return {
    ok: exitCode === 0,
    exit_code: exitCode,
    verdict_id: verdict?.verdict_id ?? null,
    current_cycle_id: verdict?.current_cycle_id ?? null,
    reason: verdict?.reason ?? null,
    jev_attempted: verdict?.jev_attempted ?? false,
    jev_available: verdict?.jev_available ?? false,
    recommends_early_cycle: verdict?.recommends_early_cycle ?? false,
    actual_outcome_appended: Boolean(actualOutcomeAppended)
  };
}

export async function runCadenceGate({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const args = parseCadenceArgs(argv, cwd);
  if (args.invalidUsage) {
    stderr.write(`jevCycleCadenceGate: ${args.diagnostics.join("; ")}\n`);
    return 2;
  }

  const threshold = parseCadenceThreshold({
    argvValue: args.thresholdRaw,
    envValue: env.JEV_CADENCE_THRESHOLD,
    defaultValue: DEFAULT_THRESHOLD
  });
  if (threshold === null) {
    stderr.write("jevCycleCadenceGate: threshold must be a finite number in (0, 1]\n");
    return 2;
  }

  const observedAt = trimToNull(args.now) || trimToNull(typeof now === "function" ? now() : now) || new Date().toISOString();
  const portfolioFallback = normalizePortfolioHeldPositions(loadJsonObject(args.portfolioPath));
  const pipelineRecords = readJsonlFile(args.pipelineLogPath);
  const calibrationRecords = readJsonlFile(args.calibrationLogPath);
  const snapshots = [];
  for (const { index, value } of pipelineRecords) {
    const normalized = normalizeCadenceSnapshotRecord(value, index, portfolioFallback);
    if (normalized) snapshots.push(normalized);
  }
  const windowSnapshots = getLatestCadenceWindow(snapshots);
  const previousSnapshot = windowSnapshots.length === 2 ? windowSnapshots[0] : null;
  const currentSnapshot = windowSnapshots.length === 2 ? windowSnapshots[1] : windowSnapshots[0] ?? null;
  const delta = windowSnapshots.length === 2 ? buildCadenceDelta(previousSnapshot, currentSnapshot) : null;

  const key = trimToNull(env.TYPESAFE_API_KEY);
  let request = { attempted: false, normalized: null, reason: "insufficient_history" };
  if (windowSnapshots.length >= 2) {
    if (!key) {
      request = { attempted: false, normalized: null, reason: "missing_credential" };
    } else {
      request = await requestCadenceJev({
        key,
        previous: previousSnapshot.data,
        current: currentSnapshot.data,
        delta,
        fetchImpl
      });
    }
  }

  const verdict = buildShadowVerdict({
    observedAt,
    threshold,
    windowSnapshots,
    delta,
    request
  });

  try {
    appendJsonLine(args.calibrationLogPath, verdict);
  } catch (error) {
    stderr.write(`jevCycleCadenceGate: failed to append shadow verdict (${error.message})\n`);
    stdout.write(`${JSON.stringify(buildStdoutResult({ verdict, actualOutcomeAppended: false, exitCode: 1 }))}\n`);
    return 1;
  }

  if (verdict.reason !== "ok" && verdict.reason !== "insufficient_history") {
    stderr.write(`jevCycleCadenceGate: ${verdict.reason}\n`);
  }

  let actualOutcomeAppended = false;
  if (windowSnapshots.length === 2 && delta) {
    const outcome = buildActualOutcomeIfNeeded({
      calibrationRecords: [...calibrationRecords.map((entry) => entry.value), verdict],
      currentSnapshot,
      previousSnapshot,
      delta,
      threshold
    });
    if (outcome) {
      try {
        appendJsonLine(args.calibrationLogPath, outcome);
        actualOutcomeAppended = true;
      } catch (error) {
        stderr.write(`jevCycleCadenceGate: failed to append actual outcome (${error.message})\n`);
        stdout.write(`${JSON.stringify(buildStdoutResult({ verdict, actualOutcomeAppended: false, exitCode: 1 }))}\n`);
        return 1;
      }
    }
  }

  stdout.write(`${JSON.stringify(buildStdoutResult({ verdict, actualOutcomeAppended, exitCode: 0 }))}\n`);
  return 0;
}

export async function main(options) {
  const code = await runCadenceGate(options);
  return code;
}

if (isDirectlyInvoked()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
