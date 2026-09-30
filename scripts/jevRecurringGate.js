#!/usr/bin/env node
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const COMPONENT_KEYS = ["head_sha", "last_ideate_digest_sha", "performance_daily_row_count", "signal_attribution_checksum"];
const SCORE_LEVELS = [
  "No P&L relevance",
  "Context only, no decision impact",
  "Indirect research or diagnostic relevance",
  "Affects a trading input but not the order path",
  "Direct entry, exit, sizing, or execution-cost impact"
];
const CHOICE_OPTIONS = ["entry", "harvest_exit", "sizing", "execution_cost"];
const FOURTEEN_DAYS_MS = 14 * 86400000;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const trimToNull = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
};

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!isObject(value)) return "null";
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function snapshotComponents(source = {}) {
  if (!isObject(source) || !COMPONENT_KEYS.every((key) => Object.hasOwn(source, key))) return null;
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, source[key] ?? null]));
}

export function buildFingerprint(components) {
  return sha256(canonicalJson(snapshotComponents(components) ?? Object.fromEntries(COMPONENT_KEYS.map((key) => [key, null]))));
}

export function diffSnapshotComponents(previous, current) {
  return COMPONENT_KEYS.filter((key) => canonicalJson(previous[key]) !== canonicalJson(current[key])).sort((a, b) => a.localeCompare(b));
}

const hasZone = (value) => /(?:Z|[+-]\d\d:\d\d)$/i.test(String(value || "").trim());
const parseTimestamp = (value) => {
  const text = String(value || "").trim();
  if (!text || !hasZone(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
};

export function evaluateHardMaxInterval({ now, lastFullPass }) {
  const nowMs = parseTimestamp(now);
  const lastMs = parseTimestamp(lastFullPass);
  if (nowMs === null || lastMs === null) return { forced: true, nowMs, lastMs };
  if (lastMs > nowMs) return { forced: false, nowMs, lastMs };
  return { forced: nowMs - lastMs >= FOURTEEN_DAYS_MS, nowMs, lastMs };
}

export function buildJevRequestBody({ previous, current, changed_components }) {
  return {
    model: "jev-latest",
    state: { previous, current, changed_components },
    questions: {
      run_full_pass: {
        type: "noul",
        instructions: "Is the delta sufficient to justify a full multi-provider discover/ideate pass?",
        criteria: {
          true: "Material repository, performance, attribution, or ideation changes justify a full pass.",
          false: "The delta is empty or irrelevant to a full discover/ideate pass."
        }
      },
      pnl_relevance: {
        type: "score",
        instructions: "How relevant is the delta to trading profit and loss?",
        criteria: SCORE_LEVELS
      },
      profit_loop: {
        type: "choice",
        instructions: "Which profit-loop stage does the delta most directly affect?",
        options: CHOICE_OPTIONS,
        criteria: {
          entry: "Changes whether a position is opened or the entry signal.",
          harvest_exit: "Changes whether or when an open position is closed.",
          sizing: "Changes position size or exposure without itself changing the entry or exit signal.",
          execution_cost: "Changes expected fees, slippage, liquidity, or other execution cost."
        }
      }
    }
  };
}

const validUnit = (value, max = 1) => Number.isFinite(value) && value >= 0 && value <= max;
const validProbabilities = (value) => value === undefined || (isObject(value) && Object.values(value).every((entry) => validUnit(entry)));

export function normalizeJevResponse(payload) {
  if (!isObject(payload) || !isObject(payload.answers)) return null;
  const noul = payload.answers.run_full_pass;
  const score = payload.answers.pnl_relevance;
  const choice = payload.answers.profit_loop;
  if (!isObject(noul) || !isObject(score) || !isObject(choice)) return null;
  if (noul.type !== "noul" || score.type !== "score" || choice.type !== "choice") return null;
  if (!validUnit(noul.noul) || !Number.isFinite(score.score) || score.score < 0 || score.score > 4 || !validUnit(score.confidence) || !CHOICE_OPTIONS.includes(choice.choice) || !validUnit(choice.confidence)) return null;
  if (!validProbabilities(noul.probabilities) || !validProbabilities(score.probabilities) || !validProbabilities(choice.probabilities)) return null;
  return {
    noul: noul.noul,
    score: score.score,
    choice: choice.choice,
    score_confidence: score.confidence,
    choice_confidence: choice.confidence
  };
}

export function buildVerdict({ invalidUsage, snapshot, previous, changedComponents, keyPresent, interval, request }) {
  const current = snapshotComponents(snapshot) ?? Object.fromEntries(COMPONENT_KEYS.map((key) => [key, null]));
  const complete = COMPONENT_KEYS.every((key) => current[key] !== null);
  const previousUsable = Boolean(previous);
  const available = Boolean(request.normalized);
  const reason = invalidUsage ? "invalid_usage"
    : !complete ? "incomplete_snapshot"
      : !previousUsable ? "initial_snapshot"
        : !keyPresent ? "missing_credential"
          : request.failure || (interval.forced ? "hard_max_interval" : "jev_signal");
  const gate = available && request.normalized.noul >= 0.5;
  return {
    schema_version: 1,
    calibration_id: buildFingerprint(current),
    snapshot: { version: 1, ...current, fingerprint: buildFingerprint(current) },
    changed_components: previousUsable ? changedComponents : [],
    mode: "shadow",
    jev_attempted: Boolean(request.attempted),
    jev_available: available,
    noul: available ? request.normalized.noul : null,
    score: available ? request.normalized.score : null,
    choice: available ? request.normalized.choice : null,
    score_confidence: available ? request.normalized.score_confidence : null,
    choice_confidence: available ? request.normalized.choice_confidence : null,
    gate_recommends_full_pass: gate,
    forced_by_hard_max_interval: interval.forced,
    would_run_full_pass: !(reason === "jev_signal" && !gate && !interval.forced),
    actual_full_pass_required: true,
    reason,
    calibration: { gate_verdict: !(reason === "jev_signal" && !gate && !interval.forced), actual_full_pass_ran: true, shippable_idea: null }
  };
}

function parseArgs(argv, cwd) {
  const options = { root: cwd, previous: null, lastIdeateSha: null, lastFullPass: null, now: null };
  let invalidUsage = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--root", "--previous", "--last-ideate-sha", "--last-full-pass", "--now"].includes(flag) || value === undefined) {
      invalidUsage = true;
      if (value !== undefined) index += 0;
      continue;
    }
    if (flag === "--root") options.root = value;
    if (flag === "--previous") options.previous = value;
    if (flag === "--last-ideate-sha") options.lastIdeateSha = value;
    if (flag === "--last-full-pass") options.lastFullPass = value;
    if (flag === "--now") options.now = value;
    index += 1;
  }
  return { ...options, invalidUsage };
}

const readJsonObject = (filePath) => {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

const readDirSorted = (dirPath, pattern) => {
  try {
    return fs.readdirSync(dirPath).filter((name) => pattern.test(name)).sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
};

function readHeadSha(root, execFileSyncImpl) {
  try {
    const stdout = execFileSyncImpl("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function countPerformanceReports(root) {
  const names = readDirSorted(path.join(root, "reports"), /^performance-daily-.*\.json$/);
  if (names === null) return null;
  return names.reduce((count, name) => {
    const report = readJsonObject(path.join(root, "reports", name));
    return count + (report?.report_type === "daily_performance" ? 1 : 0);
  }, 0);
}

function readAttributionChecksum(root) {
  const dirPath = path.join(root, "reports", "attribution");
  const names = readDirSorted(dirPath, /^signal-attribution-.*\.json$/);
  if (names === null) return null;
  let best = null;
  for (const name of names) {
    const report = readJsonObject(path.join(dirPath, name));
    if (report?.report_type !== "signal_attribution_expectancy") continue;
    // Per spec: select the greatest generated_at string (localeCompare),
    // tie-break (including missing generated_at) on the greatest basename.
    // Never use filesystem mtime -- a checkout/clone/deploy can rewrite
    // mtimes without changing content, which would make the fingerprint
    // depend on filesystem history rather than the actual report data.
    const entry = { generatedAt: typeof report.generated_at === "string" ? report.generated_at : "", name, report };
    if (!best || entry.generatedAt.localeCompare(best.generatedAt) > 0 || (entry.generatedAt === best.generatedAt && entry.name.localeCompare(best.name) > 0)) best = entry;
  }
  return best ? sha256(canonicalJson(best.report)) : null;
}

export function buildSnapshot({ root, lastIdeateDigestSha, execFileSyncImpl = execFileSync }) {
  const components = {
    head_sha: readHeadSha(root, execFileSyncImpl),
    performance_daily_row_count: countPerformanceReports(root),
    signal_attribution_checksum: readAttributionChecksum(root),
    last_ideate_digest_sha: trimToNull(lastIdeateDigestSha)
  };
  return { version: 1, ...components, fingerprint: buildFingerprint(components) };
}

function loadPreviousSnapshot(previousPath) {
  return previousPath ? snapshotComponents(readJsonObject(previousPath)) : null;
}

async function requestJev({ key, state, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildJevRequestBody(state)),
      signal: controller.signal
    });
    if (!response?.ok) return { attempted: true, normalized: null, failure: "http_failure" };
    try {
      return { attempted: true, normalized: normalizeJevResponse(await response.json()), failure: null };
    } catch {
      return { attempted: true, normalized: null, failure: "invalid_response" };
    }
  } catch (error) {
    const timeout = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError" || /timeout|abort/i.test(String(error?.message || ""));
    return { attempted: true, normalized: null, failure: timeout ? "timeout" : "http_failure" };
  } finally {
    clearTimeout(timer);
  }
}

export async function runGate({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, execFileSyncImpl = execFileSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv, cwd);
  const snapshot = buildSnapshot({ root: args.root, lastIdeateDigestSha: args.lastIdeateSha, execFileSyncImpl });
  const previous = loadPreviousSnapshot(args.previous);
  const current = snapshotComponents(snapshot);
  const changedComponents = previous ? diffSnapshotComponents(previous, current) : [];
  const key = trimToNull(env.TYPESAFE_API_KEY);
  const interval = evaluateHardMaxInterval({ now: args.now ?? new Date().toISOString(), lastFullPass: args.lastFullPass });
  let request = { attempted: false, normalized: null, failure: null };
  if (!args.invalidUsage && key && current && COMPONENT_KEYS.every((entry) => current[entry] !== null) && previous) {
    request = await requestJev({ key, state: { previous, current, changed_components: changedComponents }, fetchImpl });
    if (!request.normalized && !request.failure) request.failure = "invalid_response";
  }
  const result = buildVerdict({ invalidUsage: args.invalidUsage, snapshot, previous, changedComponents, keyPresent: Boolean(key), interval, request });
  if (args.invalidUsage) stderr.write("jevRecurringGate: invalid usage\n");
  if (request.failure) stderr.write(`jevRecurringGate: ${request.failure}\n`);
  stdout.write(`${JSON.stringify(result)}\n`);
  return args.invalidUsage ? 2 : 0;
}

export async function main(options) {
  try {
    return await runGate(options);
  } catch {
    const result = buildVerdict({
      invalidUsage: false,
      snapshot: { version: 1, head_sha: null, performance_daily_row_count: null, signal_attribution_checksum: null, last_ideate_digest_sha: null, fingerprint: buildFingerprint({}) },
      previous: null,
      changedComponents: [],
      keyPresent: false,
      interval: { forced: true },
      request: { attempted: false, normalized: null, failure: null }
    });
    (options?.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
    return 0;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === __filename) {
  main().then((code) => { process.exitCode = code; });
}
