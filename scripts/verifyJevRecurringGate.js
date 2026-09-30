#!/usr/bin/env node
import assert from "assert/strict";
import crypto from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildFingerprint, buildSnapshot, canonicalJson, evaluateHardMaxInterval, runGate } from "./jevRecurringGate.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-jev-gate-"));
// fileURLToPath decodes percent-encoded characters (spaces, unicode, etc.)
// in the file:// URL; new URL(...).pathname does not, so a repo checked out
// under a path containing them would resolve to a broken, still-encoded path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "sentinel-credential";
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const gitStub = () => "deadbeef\n";
const baseAnswers = {
  answers: {
    run_full_pass: { type: "noul", noul: 0.7 },
    pnl_relevance: { type: "score", score: 2.5, confidence: 0.8 },
    profit_loop: { type: "choice", choice: "entry", confidence: 0.6 }
  }
};

function makeRoot(tag, files = {}) {
  const root = path.join(tmpRoot, tag);
  fs.mkdirSync(path.join(root, "reports", "attribution"), { recursive: true });
  for (const [relativePath, value] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
  }
  return root;
}

function makeCompleteRoot(tag) {
  return makeRoot(tag, {
    "reports/performance-daily-a.json": { report_type: "daily_performance" },
    "reports/attribution/signal-attribution-a.json": { report_type: "signal_attribution_expectancy", generated_at: "2026-09-29T00:00:00.000Z", row: 1 }
  });
}

function writePrevious(filePath, snapshot) {
  fs.writeFileSync(filePath, JSON.stringify({
    head_sha: snapshot.head_sha,
    performance_daily_row_count: snapshot.performance_daily_row_count,
    signal_attribution_checksum: snapshot.signal_attribution_checksum,
    last_ideate_digest_sha: snapshot.last_ideate_digest_sha
  }), "utf8");
}

async function invoke({ root, previous, key, lastIdeateSha = "ideate-b", lastFullPass = "2026-09-01T00:00:00.000Z", now = "2026-09-30T00:00:00.000Z", fetchImpl = async () => ({ ok: true, json: async () => baseAnswers }) }) {
  let stdout = "";
  let stderr = "";
  const code = await runGate({
    argv: ["--root", root, "--last-ideate-sha", lastIdeateSha, "--last-full-pass", lastFullPass, "--now", now, ...(previous ? ["--previous", previous] : [])],
    env: key === undefined ? {} : { TYPESAFE_API_KEY: key },
    fetchImpl,
    execFileSyncImpl: gitStub,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } }
  });
  return { code, stdout, stderr, json: JSON.parse(stdout) };
}

try {
  const fingerprintBase = { head_sha: "deadbeef", performance_daily_row_count: 1, signal_attribution_checksum: "abc", last_ideate_digest_sha: "ideate-a" };
  assert.equal(buildFingerprint(fingerprintBase), buildFingerprint({ signal_attribution_checksum: "abc", last_ideate_digest_sha: "ideate-a", performance_daily_row_count: 1, head_sha: "deadbeef" }));
  for (const key of Object.keys(fingerprintBase)) {
    assert.notEqual(buildFingerprint({ ...fingerprintBase, [key]: key === "performance_daily_row_count" ? 2 : `${fingerprintBase[key]}-x` }), buildFingerprint(fingerprintBase));
  }

  const stableA = makeRoot("stable-a", {
    "reports/performance-daily-z.json": { rows: [1], report_type: "daily_performance" },
    "reports/attribution/signal-attribution-z.json": { report_type: "signal_attribution_expectancy", generated_at: "2026-09-29T00:00:00.000Z", z: 1, a: 2 }
  });
  const stableB = makeRoot("stable-b", {
    "reports/attribution/signal-attribution-z.json": { a: 2, report_type: "signal_attribution_expectancy", generated_at: "2026-09-29T00:00:00.000Z", z: 1 },
    "reports/performance-daily-a.json": { report_type: "daily_performance", rows: [1] }
  });
  assert.equal(buildSnapshot({ root: stableA, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }).fingerprint, buildSnapshot({ root: stableB, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }).fingerprint);

  const attributionRoot = makeRoot("attribution", {
    "reports/attribution/signal-attribution-a.json": { report_type: "signal_attribution_expectancy", generated_at: "2026-09-28T00:00:00.000Z", keep: "older" },
    "reports/attribution/signal-attribution-b.json": { report_type: "signal_attribution_expectancy", generated_at: "2026-09-29T00:00:00.000Z", keep: "loses-tie" },
    "reports/attribution/signal-attribution-c.json": { report_type: "signal_attribution_expectancy", generated_at: "2026-09-29T00:00:00.000Z", keep: "winner" },
    "reports/attribution/signal-attribution-d.json": { report_type: "other", generated_at: "2026-10-01T00:00:00.000Z" },
    "reports/attribution/signal-attribution-e.json": "{bad json",
    "reports/attribution/signal-attribution-f.json": { report_type: "signal_attribution_expectancy" },
    "reports/attribution/signal-attribution-g.json": { report_type: "signal_attribution_expectancy" }
  });
  assert.equal(buildSnapshot({ root: attributionRoot, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }).signal_attribution_checksum, sha256(canonicalJson({ report_type: "signal_attribution_expectancy", generated_at: "2026-09-29T00:00:00.000Z", keep: "winner" })));
  const missingGeneratedAt = makeRoot("attribution-missing", {
    "reports/attribution/signal-attribution-a.json": { report_type: "signal_attribution_expectancy", note: "older-name" },
    "reports/attribution/signal-attribution-b.json": { report_type: "signal_attribution_expectancy", note: "winner-name" }
  });
  assert.equal(buildSnapshot({ root: missingGeneratedAt, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }).signal_attribution_checksum, sha256(canonicalJson({ report_type: "signal_attribution_expectancy", note: "winner-name" })));

  const performanceRoot = makeRoot("performance", {
    "reports/performance-daily-a.json": { report_type: "daily_performance" },
    "reports/performance-daily-b.json": { report_type: "other" },
    "reports/performance-daily-c.json": "{bad json",
    "reports/other.json": { report_type: "daily_performance" }
  });
  assert.equal(buildSnapshot({ root: performanceRoot, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }).performance_daily_row_count, 1);
  const zeroRoot = makeRoot("performance-zero", { "reports/performance-daily-a.json": "{bad json" });
  assert.equal(buildSnapshot({ root: zeroRoot, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }).performance_daily_row_count, 0);

  const runRoot = makeCompleteRoot("run");
  const previousFile = path.join(tmpRoot, "previous.json");
  writePrevious(previousFile, buildSnapshot({ root: runRoot, lastIdeateDigestSha: "ideate-a", execFileSyncImpl: gitStub }));

  let fetchCalls = 0;
  let result = await invoke({ root: runRoot, fetchImpl: async () => { fetchCalls += 1; return { ok: true, json: async () => baseAnswers }; } });
  assert.equal(result.code, 0);
  assert.equal(result.json.reason, "initial_snapshot");
  assert.equal(result.json.jev_attempted, false);
  assert.equal(fetchCalls, 0);

  result = await invoke({ root: runRoot, previous: previousFile, lastIdeateSha: "   ", fetchImpl: async () => { fetchCalls += 1; return { ok: true, json: async () => baseAnswers }; } });
  assert.equal(result.json.reason, "incomplete_snapshot");
  assert.equal(result.code, 0);
  assert.equal(result.json.jev_attempted, false);

  fetchCalls = 0;
  result = await invoke({ root: runRoot, previous: previousFile, key: undefined, fetchImpl: async () => { fetchCalls += 1; return { ok: true, json: async () => baseAnswers }; } });
  assert.equal(result.json.reason, "missing_credential");
  assert.equal(result.code, 0);
  assert.equal(fetchCalls, 0);
  result = await invoke({ root: runRoot, previous: previousFile, key: "   ", fetchImpl: async () => { fetchCalls += 1; return { ok: true, json: async () => baseAnswers }; } });
  assert.equal(result.json.reason, "missing_credential");
  assert.equal(fetchCalls, 0);

  let seen = null;
  fetchCalls = 0;
  result = await invoke({
    root: runRoot,
    previous: previousFile,
    key: SENTINEL,
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      seen = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => baseAnswers };
    }
  });
  assert.equal(fetchCalls, 1);
  assert.equal(result.code, 0);
  assert.equal(result.json.mode, "shadow");
  assert.equal(result.json.jev_available, true);
  assert.equal(result.json.noul, 0.7);
  assert.equal(result.json.score, 2.5);
  assert.equal(result.json.choice, "entry");
  assert.equal(result.json.score_confidence, 0.8);
  assert.equal(result.json.choice_confidence, 0.6);
  assert.equal(result.json.gate_recommends_full_pass, true);
  assert.deepEqual(Object.keys(seen.body.state).sort(), ["changed_components", "current", "previous"]);
  assert.equal(seen.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.options.headers.Authorization, `Bearer ${SENTINEL}`);
  assert.equal(seen.body.model, "jev-latest");
  assert.deepEqual(Object.keys(seen.body.questions).sort(), ["pnl_relevance", "profit_loop", "run_full_pass"]);
  assert.equal(seen.body.questions.run_full_pass.type, "noul");
  assert.equal(seen.body.questions.pnl_relevance.type, "score");
  assert.equal(seen.body.questions.profit_loop.type, "choice");
  assert.equal(seen.body.questions.pnl_relevance.criteria.length, 5);
  assert.equal(seen.body.questions.profit_loop.options.length, 4);
  assert.equal(JSON.stringify(seen.body.state).includes(SENTINEL), false);

  for (const [label, failure, fetchImpl] of [
    ["timeout", "timeout", async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; }],
    ["http_failure", "http_failure", async () => ({ ok: false, json: async () => ({}) })],
    ["invalid_response_json", "invalid_response", async () => ({ ok: true, json: async () => { throw new Error("bad"); } })],
    ["invalid_response_shape", "invalid_response", async () => ({ ok: true, json: async () => ({ answers: { run_full_pass: { type: "noul", noul: 2 }, pnl_relevance: { type: "score", score: 9, confidence: 0.2 }, profit_loop: { type: "choice", choice: "wrong", confidence: 0.2 } } }) })]
  ]) {
    fetchCalls = 0;
    result = await invoke({ root: runRoot, previous: previousFile, key: SENTINEL, fetchImpl: async (...args) => { fetchCalls += 1; return fetchImpl(...args); } });
    assert.equal(result.code, 0, label);
    assert.equal(result.json.reason, failure, label);
    assert.equal(result.json.jev_available, false, label);
    assert.equal(fetchCalls, 1, label);
  }

  assert.equal(evaluateHardMaxInterval({ now: "2026-09-30T00:00:00.000Z", lastFullPass: "2026-09-16T00:00:00.001Z" }).forced, false);
  assert.equal(evaluateHardMaxInterval({ now: "2026-09-30T00:00:00.000Z", lastFullPass: "2026-09-16T00:00:00.000Z" }).forced, true);
  assert.equal(evaluateHardMaxInterval({ now: "2026-09-30T00:00:00.000Z", lastFullPass: "2026-09-15T23:59:59.999Z" }).forced, true);
  const lowSignal = async () => ({ ok: true, json: async () => ({ answers: { ...baseAnswers.answers, run_full_pass: { type: "noul", noul: 0.49 } } }) });
  result = await invoke({ root: runRoot, previous: previousFile, key: SENTINEL, lastFullPass: "2026-09-16T00:00:00.001Z", fetchImpl: lowSignal });
  assert.equal(result.json.forced_by_hard_max_interval, false);
  assert.equal(result.json.reason, "jev_signal");
  assert.equal(result.json.would_run_full_pass, false);
  assert.equal(result.json.actual_full_pass_required, true);
  result = await invoke({ root: runRoot, previous: previousFile, key: SENTINEL, lastFullPass: "2026-09-16T00:00:00.000Z", fetchImpl: lowSignal });
  assert.equal(result.json.forced_by_hard_max_interval, true);
  assert.equal(result.json.reason, "hard_max_interval");
  assert.equal(result.json.would_run_full_pass, true);

  const cli = spawnSync(process.execPath, ["scripts/jevRecurringGate.js", "--bogus"], {
    cwd: repoRoot,
    env: { ...process.env, TYPESAFE_API_KEY: SENTINEL },
    encoding: "utf8"
  });
  assert.equal(cli.status, 2);
  assert.doesNotThrow(() => JSON.parse(cli.stdout));
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  assert.match(cli.stderr, /invalid usage/);
  assert.equal(cli.stdout.includes(SENTINEL), false);
  assert.equal(cli.stderr.includes(SENTINEL), false);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("verifyJevRecurringGate: ok");
} catch (error) {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  throw error;
}
