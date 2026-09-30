#!/usr/bin/env node
// Orchestration wrapper around scripts/jevRecurringGate.js.
//
// jevRecurringGate.js is deliberately a pure, stateless calibration-signal
// primitive -- see its negotiated spec's Non-Goals ("skipping discover/ideate
// runs", "scheduling or modifying e3d-pilot itself") and Shared Constraints
// ("never write persistent state; the caller supplies the prior snapshot and
// owns persistence"). This script is that caller: it tracks state across
// cron invocations, always runs the real discover+ideate pass regardless of
// what Jev says (shadow mode never skips), and logs the calibration verdict
// for later analysis of whether Jev's judgment would ever be trustworthy
// enough to promote past shadow mode.
//
// Deliberately stops after ideate, not the full discover->ideate->draft->
// negotiate->execute->review->publish pipeline ("--stage all") -- ideate's
// automatic candidate selection has a known bias (see idea-ad28b0015d2c /
// idea-d1ff54b97c44 commit history: it picked a generic dashboard candidate
// over a substantive one today) and running unattended all the way to a
// published PR would remove the human curation step that mattered. A human
// (or a future, separately-approved automation) still picks which candidate,
// if any, actually gets implemented.

import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const STATE_DIR = path.join(REPO_ROOT, ".e3d-pilot", "jev-recurring-gate");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const CALIBRATION_LOG = path.join(STATE_DIR, "calibration.jsonl");
const RUNS_DIR = path.join(REPO_ROOT, ".e3d-pilot", "runs");
const E3D_PILOT_BIN = process.env.E3D_PILOT_BIN || "/Users/mini/e3d-pilot/bin/e3d-pilot";
const NODE_BIN = process.env.NODE_BIN || "/usr/local/bin/node";

function log(line) {
  process.stderr.write(`[jev-gated-discover-ideate] ${line}\n`);
}

// Run directories created by e3d-pilot's own discover stage are named
// run-<YYYYMMDDHHMMSS>-<slug>, which sorts lexically the same as
// chronologically -- avoids relying on filesystem mtime (which a checkout,
// clone, or deploy can rewrite without changing content) for "newest".
function findLatestIdeateResponseSha() {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(RUNS_DIR, name, "ideate-response.md")))
    .sort((a, b) => b.localeCompare(a));
  if (candidates.length === 0) return null;
  const filePath = path.join(RUNS_DIR, candidates[0], "ideate-response.md");
  try {
    const bytes = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function writeStateAtomic(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpFile, STATE_FILE);
}

function writePreviousSnapshotFile(snapshot) {
  // jevRecurringGate.js's --previous flag expects a file containing exactly
  // the four snapshot component fields (see its snapshotComponents() /
  // loadPreviousSnapshot()).
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const previousFile = path.join(STATE_DIR, "previous-snapshot.json");
  fs.writeFileSync(previousFile, JSON.stringify({
    head_sha: snapshot.head_sha,
    performance_daily_row_count: snapshot.performance_daily_row_count,
    signal_attribution_checksum: snapshot.signal_attribution_checksum,
    last_ideate_digest_sha: snapshot.last_ideate_digest_sha
  }), "utf8");
  return previousFile;
}

function runJevGate({ previousFile, lastIdeateSha, lastFullPass, now }) {
  const args = [path.join(REPO_ROOT, "scripts", "jevRecurringGate.js"), "--root", REPO_ROOT, "--now", now];
  if (previousFile) args.push("--previous", previousFile);
  if (lastIdeateSha) args.push("--last-ideate-sha", lastIdeateSha);
  if (lastFullPass) args.push("--last-full-pass", lastFullPass);
  try {
    const stdout = execFileSync(NODE_BIN, args, { cwd: REPO_ROOT, encoding: "utf8" });
    return JSON.parse(stdout.trim().split("\n").pop());
  } catch (err) {
    log(`jevRecurringGate invocation failed: ${err?.message || err}`);
    return null;
  }
}

function appendCalibrationRecord(record) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(CALIBRATION_LOG, `${JSON.stringify(record)}\n`, "utf8");
}

// Shadow mode: this always runs, regardless of what the gate verdict said.
// That is the entire point of shadow mode -- collect calibration data on
// whether Jev's judgment would have been right, without ever acting on it.
function runDiscoverAndIdeate(runId) {
  log(`running discover (run_id=${runId})`);
  execFileSync(E3D_PILOT_BIN, ["run", "--repo", REPO_ROOT, "--stage", "discover", "--run-id", runId], { cwd: REPO_ROOT, stdio: "inherit" });
  log(`running ideate (run_id=${runId})`);
  execFileSync(E3D_PILOT_BIN, ["run", "--repo", REPO_ROOT, "--stage", "ideate", "--run-id", runId], { cwd: REPO_ROOT, stdio: "inherit" });
}

function main() {
  const now = new Date().toISOString();
  const state = readState();
  const previousFile = state?.fingerprint ? writePreviousSnapshotFile(state.fingerprint) : null;
  const lastIdeateSha = findLatestIdeateResponseSha();

  const verdict = runJevGate({
    previousFile,
    lastIdeateSha,
    lastFullPass: state?.last_full_pass || null,
    now
  });

  if (verdict) {
    log(`gate verdict: reason=${verdict.reason} would_run_full_pass=${verdict.would_run_full_pass} forced_by_hard_max_interval=${verdict.forced_by_hard_max_interval}`);
    appendCalibrationRecord({ logged_at: now, verdict });
  } else {
    log("gate verdict unavailable (invocation failed) -- proceeding with full pass regardless, fail-open");
  }

  const runId = `run-${now.replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "")}-jev-gated`;
  let passSucceeded = true;
  try {
    runDiscoverAndIdeate(runId);
  } catch (err) {
    passSucceeded = false;
    log(`discover/ideate pass failed: ${err?.message || err}`);
  }

  // Re-fingerprint after the pass so next run's "previous" reflects what
  // actually happened this cycle (new ideate-response.md, possibly new
  // reports), not the pre-pass state. Reuses the same pure primitive rather
  // than recomputing snapshot logic here.
  const postPassVerdict = runJevGate({ previousFile: null, lastIdeateSha: findLatestIdeateResponseSha(), lastFullPass: null, now });
  if (postPassVerdict?.snapshot) {
    writeStateAtomic({ fingerprint: postPassVerdict.snapshot, last_full_pass: now, last_run_id: runId, last_pass_succeeded: passSucceeded });
  } else {
    log("could not re-fingerprint after pass; state not updated this cycle");
  }

  log(`cycle complete (run_id=${runId || "n/a"}, pass_succeeded=${passSucceeded})`);
}

main();
