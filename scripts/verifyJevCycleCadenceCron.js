#!/usr/bin/env node
import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-jev-cycle-cadence-cron-"));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCrontabFile = path.join(fixtureRoot, "crontab.txt");
const fakeCrontabBin = path.join(fixtureRoot, "crontab");
const installScript = path.join(repoRoot, "scripts", "installJevCycleCadenceCron.sh");
const removeScript = path.join(repoRoot, "scripts", "removeJevCycleCadenceCron.sh");
const gateScript = path.join(repoRoot, "scripts", "jevCycleCadenceGate.js");
const cronLog = path.join(repoRoot, "logs", "jev-cycle-cadence-gate.log");
const source = fs.readFileSync(installScript, "utf8") + fs.readFileSync(removeScript, "utf8");

fs.writeFileSync(fakeCrontabFile, "0 3 * * 0 /tmp/weekly-job.sh >> /tmp/weekly-job.log 2>&1\n", "utf8");
fs.writeFileSync(fakeCrontabBin, `#!/usr/bin/env bash
set -euo pipefail
STORE_FILE="${fakeCrontabFile}"
if [[ "$#" -eq 1 && "$1" == "-l" ]]; then
  if [[ -f "$STORE_FILE" ]]; then
    cat "$STORE_FILE"
    exit 0
  fi
  exit 1
fi
if [[ "$#" -eq 1 && "$1" == "-" ]]; then
  cat > "$STORE_FILE"
  exit 0
fi
echo "unsupported fake crontab args: $*" >&2
exit 1
`, { mode: 0o755 });

function runScript(scriptPath, args = []) {
  return execFileSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      JEV_CADENCE_REPO_DIR: repoRoot,
      JEV_CADENCE_NODE_BIN: process.execPath,
      JEV_CADENCE_CRONTAB_BIN: fakeCrontabBin,
      JEV_CADENCE_CRON_LOG: cronLog
    }
  }).trim();
}

try {
  assert.equal(source.includes("pipeline.js"), false);
  assert.equal(source.includes("qwen_adapter_window_runner"), false);

  const expectedCronLine = `*/15 * * * * cd "${repoRoot}" && "${process.execPath}" "${gateScript}" >> "${cronLog}" 2>&1`;
  assert.equal(runScript(installScript, ["--print"]), expectedCronLine);

  const dryRunOutput = runScript(installScript, ["--dry-run"]);
  assert.match(dryRunOutput, /would install/);
  assert.match(dryRunOutput, new RegExp(expectedCronLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const installOutput = runScript(installScript);
  assert.match(installOutput, /installed/);
  assert.match(installOutput, new RegExp(expectedCronLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const installedCrontab = fs.readFileSync(fakeCrontabFile, "utf8");
  assert.match(installedCrontab, /weekly-job/);
  assert.match(installedCrontab, new RegExp(expectedCronLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const secondInstallOutput = runScript(installScript);
  assert.equal(secondInstallOutput, "installJevCycleCadenceCron: already installed");

  const removeDryRun = runScript(removeScript, ["--dry-run"]);
  assert.equal(removeDryRun, "removeJevCycleCadenceCron: would remove");
  assert.match(fs.readFileSync(fakeCrontabFile, "utf8"), new RegExp(expectedCronLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const removeOutput = runScript(removeScript);
  assert.equal(removeOutput, "removeJevCycleCadenceCron: removed");

  const removedCrontab = fs.readFileSync(fakeCrontabFile, "utf8");
  assert.match(removedCrontab, /weekly-job/);
  assert.equal(removedCrontab.includes(expectedCronLine), false);

  const secondRemoveOutput = runScript(removeScript);
  assert.equal(secondRemoveOutput, "removeJevCycleCadenceCron: not installed");

  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  console.log("verifyJevCycleCadenceCron: ok");
} catch (error) {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  throw error;
}
