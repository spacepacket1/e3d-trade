#!/usr/bin/env node
import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  associateVerdictsToInterval,
  buildCadenceDelta,
  buildCadenceJevRequestBody,
  calculateMeaningfulMove,
  getLatestCadenceWindow,
  normalizeCadenceJevResponse,
  normalizeCadenceSnapshotRecord,
  parseCadenceThreshold,
  parseJsonlRecords,
  runCadenceGate
} from "./jevCycleCadenceGate.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-jev-cycle-cadence-"));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "jevCycleCadenceGate.js");
const SENTINEL = "sentinel-cadence-key";

function makeFixture(name) {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "portfolio.json"), JSON.stringify({
    positions: {
      fallback: { contract_address: " 0xFALLBACK ", symbol: "FB" }
    }
  }, null, 2));
  fs.writeFileSync(path.join(root, "logs", "pipeline.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(root, "logs", "jev-cycle-cadence.jsonl"), "", "utf8");
  return root;
}

function snapshotData({
  cycle_id,
  completed_at,
  approved_candidates = [],
  held_positions,
  candidate_count = 0,
  top_composite_score = null
}) {
  const data = {
    cycle_id,
    completed_at,
    approved_candidates,
    candidate_count,
    top_composite_score
  };
  if (held_positions !== undefined) data.held_positions = held_positions;
  return data;
}

function snapshotRecord(config) {
  return JSON.stringify({ stage: "cycle_cadence_snapshot", data: snapshotData(config) });
}

function shadowVerdictRecord({ verdict_id, observed_at }) {
  return JSON.stringify({
    schema_version: 1,
    record_type: "shadow_verdict",
    mode: "shadow",
    verdict_id,
    observed_at
  });
}

function parseCalibration(filePath) {
  return parseJsonlRecords(fs.readFileSync(filePath, "utf8")).map((entry) => entry.value);
}

async function invokeGate({
  root,
  pipelineLines = [],
  calibrationLines = [],
  calibrationRaw = undefined,
  portfolio = null,
  now = "2026-10-01T12:30:00.000Z",
  threshold,
  env = {},
  fetchImpl = async () => ({ ok: true, json: async () => ({ answers: {} }) })
} = {}) {
  const pipelineLogPath = path.join(root, "logs", "pipeline.jsonl");
  const calibrationLogPath = path.join(root, "logs", "jev-cycle-cadence.jsonl");
  const portfolioPath = path.join(root, "portfolio.json");
  if (portfolio) fs.writeFileSync(portfolioPath, JSON.stringify(portfolio, null, 2));
  fs.writeFileSync(pipelineLogPath, pipelineLines.join("\n") + (pipelineLines.length ? "\n" : ""), "utf8");
  fs.writeFileSync(
    calibrationLogPath,
    calibrationRaw !== undefined ? calibrationRaw : calibrationLines.join("\n") + (calibrationLines.length ? "\n" : ""),
    "utf8"
  );

  const pipelineBefore = fs.readFileSync(pipelineLogPath, "utf8");
  const portfolioBefore = fs.readFileSync(portfolioPath, "utf8");
  let stdout = "";
  let stderr = "";
  const argv = [
    "--root", root,
    "--portfolio", portfolioPath,
    "--pipeline-log", pipelineLogPath,
    "--calibration-log", calibrationLogPath,
    "--now", now
  ];
  if (threshold !== undefined) argv.push("--threshold", String(threshold));
  const code = await runCadenceGate({
    argv,
    env,
    cwd: root,
    fetchImpl,
    now: () => now,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } }
  });
  const pipelineAfter = fs.readFileSync(pipelineLogPath, "utf8");
  const portfolioAfter = fs.readFileSync(portfolioPath, "utf8");
  return {
    code,
    stdout,
    stderr,
    result: stdout.trim() ? JSON.parse(stdout) : null,
    calibration: parseCalibration(calibrationLogPath),
    pipelineBefore,
    pipelineAfter,
    portfolioBefore,
    portfolioAfter
  };
}

try {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.equal(/\bpipeline\.js\b/.test(source), false);
  assert.equal(source.includes("qwen_adapter_window_runner"), false);
  assert.equal(/\bchild_process\b/.test(source), false);
  assert.equal(/\bspawn\b/.test(source), false);
  assert.equal(/\bSIG[A-Z]+\b/.test(source), false);

  assert.equal(parseCadenceThreshold({ argvValue: null, envValue: null }), 0.05);
  assert.equal(parseCadenceThreshold({ argvValue: "0.1", envValue: "0.2" }), 0.1);
  assert.equal(parseCadenceThreshold({ argvValue: null, envValue: "0.2" }), 0.2);
  assert.equal(parseCadenceThreshold({ argvValue: "2" }), null);

  const normalizedSnapshot = normalizeCadenceSnapshotRecord(
    { stage: "cycle_cadence_snapshot", data: snapshotData({ cycle_id: "cycle-fallback", completed_at: "2026-10-01T00:00:00.000Z" }) },
    0,
    [{ address: "0xfallback", symbol: "FB", current_price: null }]
  );
  assert.deepEqual(normalizedSnapshot.data.held_positions, [{ address: "0xfallback", symbol: "FB", current_price: null }]);

  const previousSnapshot = normalizeCadenceSnapshotRecord({
    stage: "cycle_cadence_snapshot",
    data: snapshotData({
      cycle_id: "cycle-a",
      completed_at: "2026-10-01T00:00:00.000Z",
      approved_candidates: [{ address: " 0xAbC ", symbol: "AAA" }],
      held_positions: [
        { address: "0xhold1", symbol: "H1", current_price: 100 },
        { address: "0xhold2", symbol: "H2", current_price: 0 },
        { address: "0xhold3", symbol: "H3", current_price: 50 }
      ],
      candidate_count: 3,
      top_composite_score: 91
    })
  }, 0, []);
  const currentSnapshot = normalizeCadenceSnapshotRecord({
    stage: "cycle_cadence_snapshot",
    data: snapshotData({
      cycle_id: "cycle-b",
      completed_at: "2026-10-01T06:00:00.000Z",
      approved_candidates: [
        { address: "0xabc", symbol: "AAA" },
        { address: " 0xDEF ", symbol: "DDD" },
        { address: "0xdef", symbol: "DDD-SECOND" }
      ],
      held_positions: [
        { address: "0xhold1", symbol: "H1", current_price: 105 },
        { address: "0xhold2", symbol: "H2", current_price: 10 },
        { address: "0xhold3", symbol: "H3", current_price: null },
        { address: "0xhold4", symbol: "H4", current_price: 5 }
      ],
      candidate_count: 5,
      top_composite_score: 96
    })
  }, 1, []);
  const delta = buildCadenceDelta(previousSnapshot, currentSnapshot);
  assert.equal(delta.candidate_count_delta, 2);
  assert.equal(delta.top_composite_score_delta, 5);
  assert.deepEqual(delta.new_approved_candidates, [{ address: "0xdef", symbol: "DDD" }]);
  assert.deepEqual(delta.held_position_price_changes, [{
    address: "0xhold1",
    symbol: "H1",
    previous_price: 100,
    current_price: 105,
    abs_change_pct: 0.05
  }]);
  assert.equal(delta.max_abs_held_move_pct, 0.05);
  assert.equal(calculateMeaningfulMove(0.05, 0.05), true);
  assert.equal(calculateMeaningfulMove(0.049, 0.05), false);

  const nullScoreDelta = buildCadenceDelta(
    normalizeCadenceSnapshotRecord({ stage: "cycle_cadence_snapshot", data: snapshotData({ cycle_id: "x", completed_at: "2026-10-01T00:00:00.000Z", top_composite_score: null }) }, 0, []),
    normalizeCadenceSnapshotRecord({ stage: "cycle_cadence_snapshot", data: snapshotData({ cycle_id: "y", completed_at: "2026-10-01T01:00:00.000Z", top_composite_score: 50 }) }, 1, [])
  );
  assert.equal(nullScoreDelta.top_composite_score_delta, null);

  const orderedWindow = getLatestCadenceWindow([
    normalizeCadenceSnapshotRecord({ stage: "cycle_cadence_snapshot", data: snapshotData({ cycle_id: "c2", completed_at: "2026-10-01T02:00:00.000Z" }) }, 2, []),
    normalizeCadenceSnapshotRecord({ stage: "cycle_cadence_snapshot", data: snapshotData({ cycle_id: "c1", completed_at: "2026-10-01T02:00:00.000Z" }) }, 1, []),
    normalizeCadenceSnapshotRecord({ stage: "cycle_cadence_snapshot", data: snapshotData({ cycle_id: "c0", completed_at: "2026-10-01T01:00:00.000Z" }) }, 0, [])
  ]);
  assert.deepEqual(orderedWindow.map((entry) => entry.data.cycle_id), ["c1", "c2"]);

  const requestBody = buildCadenceJevRequestBody({
    previous: previousSnapshot.data,
    current: currentSnapshot.data,
    delta
  });
  assert.equal(requestBody.model, "jev-latest");
  assert.deepEqual(requestBody.state.previous, previousSnapshot.data);
  assert.deepEqual(requestBody.state.current, currentSnapshot.data);
  assert.equal(requestBody.questions.run_early_cycle.instructions, "Is the delta sufficient to justify an early full Scout/Harvest cycle?");
  assert.deepEqual(requestBody.questions.change_materiality.criteria, [
    "No Scout/Harvest timing relevance",
    "Context only, no cadence impact",
    "Indirect research or diagnostic relevance",
    "Affects Scout/Harvest inputs but not enough to pull the cycle forward",
    "Directly warrants an early full Scout/Harvest cycle"
  ]);
  assert.deepEqual(requestBody.questions.dominant_driver.options, ["candidate_count", "top_composite_score", "new_approvals", "held_position_move"]);

  assert.deepEqual(normalizeCadenceJevResponse({
    answers: {
      run_early_cycle: { type: "noul", noul: 0.49, probabilities: { true: 0.49, false: 0.51 } },
      change_materiality: { type: "score", score: 2, confidence: 0.6, probabilities: { "0": 0.1 } },
      dominant_driver: { type: "choice", choice: "new_approvals", confidence: 0.7, probabilities: { new_approvals: 0.7 } }
    }
  }), {
    noul: 0.49,
    score: 2,
    choice: "new_approvals",
    score_confidence: 0.6,
    choice_confidence: 0.7
  });
  assert.equal(normalizeCadenceJevResponse({
    answers: {
      run_early_cycle: { type: "noul", noul: 1.2 },
      change_materiality: { type: "score", score: 2, confidence: 0.6 },
      dominant_driver: { type: "choice", choice: "new_approvals", confidence: 0.7 }
    }
  }), null);
  assert.equal(normalizeCadenceJevResponse({
    answers: {
      run_early_cycle: { type: "noul", noul: 0.5 },
      change_materiality: { type: "score", score: 2, confidence: 1.2 },
      dominant_driver: { type: "choice", choice: "new_approvals", confidence: 0.7 }
    }
  }), null);
  assert.equal(normalizeCadenceJevResponse({
    answers: {
      run_early_cycle: { type: "noul", noul: 0.5 },
      change_materiality: { type: "score", score: 2, confidence: 0.6 },
      dominant_driver: { type: "choice", choice: "wrong", confidence: 0.7 }
    }
  }), null);

  assert.deepEqual(associateVerdictsToInterval([
    { record_type: "shadow_verdict", verdict_id: "eq-prev", observed_at: "2026-10-01T00:00:00.000Z" },
    { record_type: "shadow_verdict", verdict_id: "inside-1", observed_at: "2026-10-01T01:00:00.000Z" },
    { record_type: "shadow_verdict", verdict_id: "inside-2", observed_at: "2026-10-01T06:00:00.000Z" },
    { record_type: "shadow_verdict", verdict_id: "after", observed_at: "2026-10-01T06:00:00.001Z" },
    { record_type: "shadow_verdict", verdict_id: "bad", observed_at: "nope" }
  ], {
    previousCompletedAt: "2026-10-01T00:00:00.000Z",
    currentCompletedAt: "2026-10-01T06:00:00.000Z"
  }), ["inside-1", "inside-2"]);

  const requestRoot = makeFixture("request");
  let seenRequest = null;
  const requestRun = await invokeGate({
    root: requestRoot,
    pipelineLines: [
      "{bad json",
      JSON.stringify({ stage: "other", data: {} }),
      snapshotRecord({
        cycle_id: "cycle-prev",
        completed_at: "2026-10-01T00:00:00.000Z",
        approved_candidates: [{ address: "0xaaa", symbol: "AAA" }],
        held_positions: [{ address: "0xhold1", symbol: "H1", current_price: 100 }],
        candidate_count: 2,
        top_composite_score: 88
      }),
      snapshotRecord({
        cycle_id: "cycle-current",
        completed_at: "2026-10-01T06:00:00.000Z",
        approved_candidates: [{ address: "0xbbb", symbol: "BBB" }],
        held_positions: [{ address: "0xhold1", symbol: "H1", current_price: 105 }],
        candidate_count: 4,
        top_composite_score: 90
      })
    ],
    calibrationLines: [
      shadowVerdictRecord({ verdict_id: "at-prev", observed_at: "2026-10-01T00:00:00.000Z" }),
      shadowVerdictRecord({ verdict_id: "inside", observed_at: "2026-10-01T03:00:00.000Z" }),
      shadowVerdictRecord({ verdict_id: "at-current", observed_at: "2026-10-01T06:00:00.000Z" }),
      shadowVerdictRecord({ verdict_id: "after", observed_at: "2026-10-01T06:00:00.001Z" }),
      "{malformed"
    ],
    env: { TYPESAFE_API_KEY: SENTINEL },
    now: "2026-10-01T12:30:00.000Z",
    fetchImpl: async (url, options) => {
      seenRequest = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          answers: {
            run_early_cycle: { type: "noul", noul: 0.5 },
            change_materiality: { type: "score", score: 4, confidence: 0.9 },
            dominant_driver: { type: "choice", choice: "held_position_move", confidence: 0.8 }
          }
        })
      };
    }
  });
  assert.equal(requestRun.code, 0);
  assert.equal(requestRun.result.reason, "ok");
  assert.equal(requestRun.result.recommends_early_cycle, true);
  assert.equal(requestRun.result.actual_outcome_appended, true);
  assert.equal(requestRun.pipelineBefore, requestRun.pipelineAfter);
  assert.equal(requestRun.portfolioBefore, requestRun.portfolioAfter);
  assert.equal(requestRun.stdout.includes(SENTINEL), false);
  assert.equal(requestRun.stderr.includes(SENTINEL), false);
  assert.equal(seenRequest.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seenRequest.options.headers.Authorization, `Bearer ${SENTINEL}`);
  assert.equal(seenRequest.body.model, "jev-latest");
  assert.deepEqual(Object.keys(seenRequest.body.state).sort(), ["current", "delta", "previous"]);
  assert.deepEqual(seenRequest.body.state.previous, {
    cycle_id: "cycle-prev",
    completed_at: "2026-10-01T00:00:00.000Z",
    approved_candidates: [{ address: "0xaaa", symbol: "AAA" }],
    held_positions: [{ address: "0xhold1", symbol: "H1", current_price: 100 }],
    candidate_count: 2,
    top_composite_score: 88
  });
  assert.deepEqual(Object.keys(seenRequest.body.questions).sort(), ["change_materiality", "dominant_driver", "run_early_cycle"]);
  assert.equal(seenRequest.body.questions.run_early_cycle.type, "noul");
  assert.equal(seenRequest.body.questions.change_materiality.type, "score");
  assert.equal(seenRequest.body.questions.dominant_driver.type, "choice");
  const requestOutcome = requestRun.calibration.find((entry) => entry.record_type === "actual_outcome");
  assert.deepEqual(requestOutcome.associated_verdict_ids, ["inside", "at-current"]);
  assert.deepEqual(requestOutcome.meaningful_held_moves, [{
    address: "0xhold1",
    symbol: "H1",
    previous_price: 100,
    current_price: 105,
    abs_change_pct: 0.05
  }]);

  const lowSignalRoot = makeFixture("low-signal");
  const lowSignalRun = await invokeGate({
    root: lowSignalRoot,
    pipelineLines: [
      snapshotRecord({ cycle_id: "a", completed_at: "2026-10-01T00:00:00.000Z" }),
      snapshotRecord({ cycle_id: "b", completed_at: "2026-10-01T06:00:00.000Z" })
    ],
    env: { TYPESAFE_API_KEY: SENTINEL },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        answers: {
          run_early_cycle: { type: "noul", noul: 0.49 },
          change_materiality: { type: "score", score: 1, confidence: 0.4 },
          dominant_driver: { type: "choice", choice: "candidate_count", confidence: 0.3 }
        }
      })
    })
  });
  assert.equal(lowSignalRun.result.reason, "ok");
  assert.equal(lowSignalRun.result.recommends_early_cycle, false);

  const zeroRoot = makeFixture("zero");
  const zeroRun = await invokeGate({ root: zeroRoot, env: { TYPESAFE_API_KEY: SENTINEL } });
  assert.equal(zeroRun.code, 0);
  assert.equal(zeroRun.calibration.length, 1);
  assert.deepEqual(zeroRun.calibration[0], {
    schema_version: 1,
    record_type: "shadow_verdict",
    mode: "shadow",
    verdict_id: zeroRun.calibration[0].verdict_id,
    observed_at: "2026-10-01T12:30:00.000Z",
    previous_cycle_id: null,
    current_cycle_id: null,
    source_cycle_window: null,
    input_snapshot: { meaningful_move_threshold: 0.05 },
    jev_attempted: false,
    jev_available: false,
    noul: null,
    score: null,
    choice: null,
    score_confidence: null,
    choice_confidence: null,
    recommends_early_cycle: false,
    reason: "insufficient_history"
  });

  const oneRoot = makeFixture("one");
  const oneRun = await invokeGate({
    root: oneRoot,
    pipelineLines: [snapshotRecord({ cycle_id: "only-cycle", completed_at: "2026-10-01T00:00:00.000Z" })],
    env: { TYPESAFE_API_KEY: SENTINEL }
  });
  assert.equal(oneRun.calibration[0].previous_cycle_id, null);
  assert.equal(oneRun.calibration[0].current_cycle_id, "only-cycle");
  assert.equal(oneRun.calibration[0].reason, "insufficient_history");
  assert.deepEqual(oneRun.calibration[0].input_snapshot, { meaningful_move_threshold: 0.05 });

  const missingKeyRoot = makeFixture("missing-key");
  const missingKeyRun = await invokeGate({
    root: missingKeyRoot,
    pipelineLines: [
      snapshotRecord({ cycle_id: "prev", completed_at: "2026-10-01T00:00:00.000Z" }),
      snapshotRecord({ cycle_id: "curr", completed_at: "2026-10-01T06:00:00.000Z" })
    ],
    env: { TYPESAFE_API_KEY: "   " }
  });
  assert.equal(missingKeyRun.result.reason, "missing_credential");
  assert.match(missingKeyRun.stderr, /missing_credential/);
  assert.equal(missingKeyRun.calibration.filter((entry) => entry.record_type === "actual_outcome").length, 1);

  for (const [name, fetchImpl, expectedReason] of [
    ["timeout", async () => { const error = new Error("timed out"); error.name = "AbortError"; throw error; }, "timeout"],
    ["http-failure", async () => ({ ok: false, json: async () => ({}) }), "http_failure"],
    ["network-failure", async () => { throw new Error("socket hang up"); }, "http_failure"],
    ["bad-json", async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }), "invalid_response"],
    ["bad-normalized", async () => ({ ok: true, json: async () => ({ answers: { run_early_cycle: { type: "noul", noul: 0.2 }, change_materiality: { type: "score", score: 7, confidence: 0.1 }, dominant_driver: { type: "choice", choice: "wrong", confidence: 0.1 } } }) }), "invalid_response"]
  ]) {
    const root = makeFixture(name);
    const run = await invokeGate({
      root,
      pipelineLines: [
        snapshotRecord({ cycle_id: "prev", completed_at: "2026-10-01T00:00:00.000Z" }),
        snapshotRecord({ cycle_id: "curr", completed_at: "2026-10-01T06:00:00.000Z" })
      ],
      env: { TYPESAFE_API_KEY: SENTINEL },
      fetchImpl
    });
    assert.equal(run.result.reason, expectedReason, name);
    assert.equal(run.result.jev_attempted, true, name);
    assert.equal(run.result.jev_available, false, name);
  }

  const malformedRoot = makeFixture("malformed");
  const malformedRun = await invokeGate({
    root: malformedRoot,
    pipelineLines: [
      "{bad",
      JSON.stringify({ stage: "wrong" }),
      snapshotRecord({ cycle_id: "only", completed_at: "2026-10-01T00:00:00.000Z" }),
      "{\"stage\":\"cycle_cadence_snapshot\",\"data\":{\"cycle_id\":\"missing-time\"}}"
    ],
    calibrationLines: ["{bad", shadowVerdictRecord({ verdict_id: "keep", observed_at: "2026-10-01T01:00:00.000Z" })],
    env: {}
  });
  assert.equal(malformedRun.result.reason, "insufficient_history");
  assert.equal(malformedRun.calibration.filter((entry) => entry.record_type === "shadow_verdict").length, 2);

  const unterminatedRoot = makeFixture("unterminated-calibration");
  const unterminatedExisting = shadowVerdictRecord({ verdict_id: "pre-existing", observed_at: "2026-10-01T00:30:00.000Z" });
  const unterminatedRun = await invokeGate({
    root: unterminatedRoot,
    pipelineLines: [
      snapshotRecord({ cycle_id: "prev", completed_at: "2026-10-01T00:00:00.000Z" }),
      snapshotRecord({ cycle_id: "curr", completed_at: "2026-10-01T06:00:00.000Z" })
    ],
    calibrationRaw: unterminatedExisting,
    env: {}
  });
  const unterminatedLines = fs.readFileSync(path.join(unterminatedRoot, "logs", "jev-cycle-cadence.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(unterminatedLines.length, 3, "unterminated: each appended record must land on its own line, not concatenated onto the prior one");
  assert.equal(unterminatedRun.calibration.length, 3, "unterminated: the pre-existing record and both newly appended records must parse");
  assert.equal(unterminatedRun.calibration[0].verdict_id, "pre-existing");
  assert.equal(unterminatedRun.calibration[1].record_type, "shadow_verdict");

  const repeatRoot = makeFixture("repeat");
  const repeatLines = [
    shadowVerdictRecord({ verdict_id: "between", observed_at: "2026-10-01T03:00:00.000Z" })
  ];
  const repeatBase = {
    root: repeatRoot,
    pipelineLines: [
      snapshotRecord({ cycle_id: "prev", completed_at: "2026-10-01T00:00:00.000Z" }),
      snapshotRecord({ cycle_id: "curr", completed_at: "2026-10-01T06:00:00.000Z" })
    ],
    calibrationLines: repeatLines,
    env: { TYPESAFE_API_KEY: "   " },
    now: "2026-10-01T12:30:00.000Z"
  };
  const repeatFirst = await invokeGate(repeatBase);
  assert.equal(repeatFirst.calibration.filter((entry) => entry.record_type === "actual_outcome").length, 1);
  const repeatSecond = await invokeGate({
    ...repeatBase,
    calibrationLines: repeatFirst.calibration.map((entry) => JSON.stringify(entry)),
    now: "2026-10-01T12:45:00.000Z"
  });
  assert.equal(repeatSecond.calibration.filter((entry) => entry.record_type === "actual_outcome").length, 1);
  assert.equal(repeatSecond.calibration.filter((entry) => entry.record_type === "shadow_verdict").length, 3);

  const invalidThresholdRoot = makeFixture("invalid-threshold");
  const invalidThresholdRun = await invokeGate({
    root: invalidThresholdRoot,
    threshold: "0",
    pipelineLines: [snapshotRecord({ cycle_id: "prev", completed_at: "2026-10-01T00:00:00.000Z" })],
    env: { TYPESAFE_API_KEY: SENTINEL }
  });
  assert.equal(invalidThresholdRun.code, 2);
  assert.equal(invalidThresholdRun.result, null);
  assert.equal(invalidThresholdRun.calibration.length, 0);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("verifyJevCycleCadenceGate: ok");
} catch (error) {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  throw error;
}
