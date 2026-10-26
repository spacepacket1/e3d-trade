#!/usr/bin/env node
// Runs the offline-safe verify*.js scripts, each in its own child process with a timeout.
//
// Safety model (additive tooling only; nothing here trades):
//  - Only scripts in SAFE_OFFLINE run. Everything else is listed as skipped with a reason.
//  - Any scripts/verify*.js that is in neither list is reported as UNCLASSIFIED and not run.
//  - Children get a minimal environment (no API keys, no wallet vars, no live-execution flags).
//  - On macOS, children run under sandbox-exec with all network denied and writes to
//    .env / portfolio.json denied, so a script that unexpectedly needs the network fails
//    instead of reaching out. Use --no-sandbox to disable; the runner then relies on the
//    allowlist alone.
// Note: pipeline.js reads <repo>/.env on import (existing behaviour). The sandbox does not
// block reads, so run this from a checkout without a .env if you want zero exposure.
//
// Usage: node scripts/run-verify.js [--timeout-ms=120000] [--only=substr] [--no-sandbox]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SAFE_OFFLINE = [
  "verifyAddressRepairTelemetry.js", "verifyAttribution.js", "verifyAuditTrail.js",
  "verifyCapitalMandates.js", "verifyCooldownDecay.js", "verifyCustodyControls.js",
  "verifyDeskCore.js", "verifyE3dActionOutcomeExport.js", "verifyE3dActionOutcomeExportCron.js",
  "verifyEvidenceDiagnostics.js", "verifyEvidencePackets.js", "verifyFunnelRollup.js",
  "verifyHarvestMapsPrecheck.js", "verifyJevCycleCadenceCron.js", "verifyJevCycleCadenceGate.js",
  "verifyJevRecurringGate.js", "verifyLiquidityExecutionControls.js", "verifyLiveCaps.js",
  "verifyLiveProcessLock.js", "verifyLiveQuote.js", "verifyMarketDataQuality.js",
  "verifyOperationsMonitor.js", "verifyPaperExecutionRealism.js", "verifyPartialSellFloor.js",
  "verifyPortfolioSnapshotWriter.js", "verifyProfitTakeCalibration.js", "verifyPromotionGates.js",
  "verifyRegimeSentinelThrottle.js", "verifyRiskEngine.js", "verifyRotationFrictionGuard.js",
  "verifyScoutMapsRoute.js", "verifyScoutRelaxation.js", "verifyTokenRiskScanner.js",
  "verifyTradeEvidence.js", "verifyTrendSleevePersistence.js",
  // Evaluation foundation (synthetic fixtures only; no logs, no network).
  "verifyCandidateSnapshots.js", "verifySettingsHash.js", "verifyBaselineCompare.js", "verifyBackfillSnapshots.js"
];

const SKIPPED = {
  "verifyLiveExecutorFork.js": "needs network + live wallet: reads .env, forks mainnet via ETH_RPC_URL with anvil, loads the hot wallet",
  "verifyLivePipelineFork.js": "needs network + live wallet: reads .env, forks mainnet with anvil, loads the hot wallet, touches the live executor state file",
  "verifyMacroCrossAssetClient.js": "needs network: calls Yahoo/Stooq through marketData.js (live fetch, no fixture)",
  "verifyMapsClient.js": "needs network: calls the Maps context service (live fetch, no fixture)"
};

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const timeoutMs = Number(opt("timeout-ms", 120000));
const only = opt("only", "");
const useSandbox = !args.includes("--no-sandbox") && process.platform === "darwin" &&
  spawnSync("sandbox-exec", ["-n", "no-network", "true"], { stdio: "ignore" }).error == null;

const onDisk = fs.readdirSync(path.join(repoRoot, "scripts")).filter((f) => /^verify.*\.js$/.test(f)).sort();
const unclassified = onDisk.filter((f) => !SAFE_OFFLINE.includes(f) && !(f in SKIPPED));
const missing = SAFE_OFFLINE.filter((f) => !onDisk.includes(f));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "run-verify-"));
const childEnv = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || tmpHome,
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  NODE_ENV: "test",
  PORTFOLIO_FILE_PATH: path.join(tmpHome, "portfolio.json")
};

function sandboxProfile() {
  const q = (p) => JSON.stringify(p);
  return `(version 1)(allow default)(deny network*)` +
    `(deny file-write* (literal ${q(path.join(repoRoot, ".env"))}) (literal ${q(path.join(repoRoot, "portfolio.json"))}))`;
}

function runOne(file) {
  return new Promise((resolve) => {
    const script = path.join("scripts", file);
    const cmd = useSandbox ? "sandbox-exec" : process.execPath;
    const cmdArgs = useSandbox ? ["-p", sandboxProfile(), process.execPath, script] : [script];
    const started = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (d) => { out = (out + d).slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const status = timedOut ? "TIMEOUT" : code === 0 ? "PASS" : "FAIL";
      resolve({ file, status, code, signal, ms: Date.now() - started, tail: out.trim() });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ file, status: "FAIL", code: null, ms: Date.now() - started, tail: String(e) }); });
  });
}

const selected = SAFE_OFFLINE.filter((f) => onDisk.includes(f) && f.includes(only));
console.log(`verify runner: ${selected.length} scripts, timeout ${timeoutMs}ms, network sandbox ${useSandbox ? "ON" : "OFF"}`);
const results = [];
for (const f of selected) {
  const r = await runOne(f);
  results.push(r);
  console.log(`${r.status.padEnd(7)} ${f} (${(r.ms / 1000).toFixed(1)}s)`);
}
fs.rmSync(tmpHome, { recursive: true, force: true });

const failed = results.filter((r) => r.status !== "PASS");
console.log("\nRESULT TABLE");
console.log("status  secs   script");
for (const r of results) console.log(`${r.status.padEnd(7)} ${(r.ms / 1000).toFixed(1).padStart(5)}  ${r.file}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const r of failed) {
  console.log(`\n--- ${r.file} (${r.status}, exit ${r.code}${r.signal ? ", " + r.signal : ""}) last output:\n${r.tail}`);
}
console.log("\nSKIPPED (not run)");
for (const [f, why] of Object.entries(SKIPPED)) console.log(`  ${f}: ${why}`);
for (const f of unclassified) console.log(`  ${f}: UNCLASSIFIED (new script, not in SAFE_OFFLINE or SKIPPED; add it to scripts/run-verify.js)`);
for (const f of missing) console.log(`  ${f}: listed as safe but missing on disk`);
process.exit(failed.length || missing.length ? 1 : 0);
