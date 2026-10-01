# Shadow-Mode Jev Gate for Scout/Harvest Cycle Cadence

## Overview

Add an independent 15-minute Jev calibration sidecar that observes whether changes would justify an early Scout/Harvest cycle and associates shadow verdicts with later scheduled-cycle outcomes. It must never trigger, skip, delay, or otherwise alter a trading cycle.

## Goals

- Build a calibration record of whether Jev's judgment on "has enough changed to warrant a full cycle now" would agree with what the real, scheduled cycle actually found when it eventually ran.
- Run this check on a tight, independent 15-minute cadence, completely decoupled from the existing 4x/day Scout/Harvest schedule.
- Produce deterministic, append-only telemetry (shadow verdicts and actual outcomes) suitable for later human review of Jev's calibration accuracy.
- Follow the exact, already-verified-correct Jev wire format (`api.typesafe.ai/v1/systemone`, Noul/Score/Choice with nested `criteria`) used in `scripts/jevRecurringGate.js`.

## Non-Goals

- Changing when Scout/Harvest cycles actually run, now or ever, as part of this candidate. This is pure logging/calibration.
- Scout candidate triage via Jev (letting Jev pre-rank which candidates Qwen reasons about) -- a separate, later idea once this calibration data exists.
- Harvest position-skip via Jev (letting Jev decide which held positions get full LLM re-review each cycle) -- a separate, later idea.
- Any change to `qwen_adapter_window_runner.sh`'s scheduling, window logic, or shared-LLM-worker coordination.
- Any change to Scout's or Harvest's actual candidate-scoring, exit-decision, or risk logic.
- Importing or calling `buildJevRequestBody` or `normalizeJevResponse` from `scripts/jevRecurringGate.js` -- that module is a separate, unrelated gate (e3d-pilot's own discover/ideate cadence against this repo); this candidate implements its own local cadence helpers modeled on the same wire format, not a shared dependency.

## Existing Files

- `pipeline.js` is the trading pipeline; `runCycle()` already builds `_lastCognitiveState` (Scout's deterministic candidate scoring) and logs cycle telemetry via the existing `log()` helper before calling `savePortfolio(portfolio)`.
- `scripts/jevRecurringGate.js` (merged Sep 2026) is the canonical, verified-correct reference for the real Jev API wire format -- `api.typesafe.ai/v1/systemone`, Noul (`criteria: {true, false}`), Score (`criteria:` ordered array), Choice (`criteria:` object map), via `buildJevRequestBody`/`normalizeJevResponse`. This candidate's own request/response handling must match that wire format exactly; do not re-derive it from general knowledge, since this exact schema has repeatedly been hallucinated differently (flat `true_criteria`/`false_criteria`, `.probability` instead of `.noul`) in earlier work on this codebase.
- `scripts/portfolioSnapshotWriter.js` and its `scripts/installPortfolioSnapshotCron.sh`/`scripts/removePortfolioSnapshotCron.sh` are the existing cron install/remove pattern to follow for this sidecar's own cron wrappers.
- `/Users/mini/e3d-maps/deploy/qwen_adapter_window_runner.sh` is the existing 4x/day Scout/Harvest scheduler (shared local-LLM timeshare with maps/story) -- read for context only, must not be modified or referenced by any new script.
- `package.json` defines the `npm run check` verification chain.

## Shared Constraints

- Use `codex:gpt-5.4`.
- Change only these seven files: `pipeline.js`, `scripts/jevCycleCadenceGate.js`, `scripts/installJevCycleCadenceCron.sh`, `scripts/removeJevCycleCadenceCron.sh`, `scripts/verifyJevCycleCadenceGate.js`, `scripts/verifyJevCycleCadenceCron.js`, and `package.json`.
- Stay within 1,600 changed lines.
- Treat `portfolio.json`, `logs/pipeline.jsonl`, and `logs/jev-cycle-cadence.jsonl` as uncommitted runtime data.
- The sidecar may append only to its calibration JSONL. It may read, but never write, portfolio or pipeline-log data.
- The sidecar must not import, execute, spawn, or signal `pipeline.js`, invoke a pipeline start/loop command, or expose a trigger/skip/delay path.
- Do not modify `qwen_adapter_window_runner.sh`.
- Add no network call except one eligible Jev POST to `https://api.typesafe.ai/v1/systemone`.
- Implement local cadence helpers; do not import or call `buildJevRequestBody` or `normalizeJevResponse` from `scripts/jevRecurringGate.js`.
- Never log credentials or authorization headers.
- Missing credentials, malformed data, unavailable Jev, partial JSONL lines, and empty history must fail safely.
- Verify with exactly `npm install && npm run check`.

## Phase 1 - Shadow-Mode Jev Cadence Gate

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/jevCycleCadenceGate.js -->
<!-- pilot:touches=scripts/installJevCycleCadenceCron.sh -->
<!-- pilot:touches=scripts/removeJevCycleCadenceCron.sh -->
<!-- pilot:touches=scripts/verifyJevCycleCadenceGate.js -->
<!-- pilot:touches=scripts/verifyJevCycleCadenceCron.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=package.json -->
<!-- runner:read=pipeline.js -->
<!-- runner:read=scripts/jevRecurringGate.js -->
<!-- runner:read=scripts/portfolioSnapshotWriter.js -->
<!-- runner:read=scripts/installPortfolioSnapshotCron.sh -->
<!-- runner:read=scripts/removePortfolioSnapshotCron.sh -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

#### Pipeline Telemetry

Extend `pipeline.js` without changing trading, scheduling, scoring, execution, or portfolio serialization.

Add `buildCycleCadenceSnapshot(trainingContext, approved, portfolio, cognitiveState)`. After step 9 market-value recomputation and `log("stats", stats)`, but before `savePortfolio(portfolio)`, append one record through the existing logger:

- `stage: "cycle_cadence_snapshot"`
- `data.cycle_id`: `trainingContext.cycle_id`
- `data.completed_at`: `nowIso()`
- `data.approved_candidates`: Risk-approved candidates as `{ address, symbol }`; use trimmed lowercase `token.contract_address` or `contract_address`, omitting entries without an address
- `data.held_positions`: portfolio positions as `{ address, symbol, current_price }`; normalize `contract_address`, omit entries without an address, and use a finite numeric price or `null`
- `data.candidate_count`: cognitive-state candidate length or `0`
- `data.top_composite_score`: maximum finite `scorecard.composite_score`, otherwise `null`

Use `_lastCognitiveState`; do not call `buildCognitiveState()` again. If it is absent, emit count `0` and top score `null`.

#### Sidecar Module and CLI

Create `scripts/jevCycleCadenceGate.js` as an importable, dependency-injectable ES module and CLI.

Export `runCadenceGate` and pure helpers for argument parsing, JSONL parsing, snapshot normalization, delta construction, meaningful-move calculation, request construction, response normalization, interval association, and idempotent outcome construction. Inject `argv`, `env`, `cwd`, `fetchImpl`, `now`, `stdout`, and `stderr`.

Support:

- `--root`
- `--portfolio`
- `--pipeline-log`
- `--calibration-log`
- `--now`
- `--threshold`

Defaults are repository-local `portfolio.json`, `logs/pipeline.jsonl`, and `logs/jev-cycle-cadence.jsonl`. Resolve defaults relative to `--root` when supplied; explicit file flags override `--root`.

The threshold defaults to `0.05`. Precedence is `--threshold`, then `JEV_CADENCE_THRESHOLD`, then the default. It must parse as a finite number in `(0, 1]`; otherwise print diagnostics, append nothing, and exit `2`.

Parse JSONL defensively, ignoring blank, malformed, partial, and irrelevant records.

A valid cadence snapshot is a `stage === "cycle_cadence_snapshot"` record whose `data` is an object with nonblank `cycle_id` and a parseable `completed_at`. Normalize optional arrays and numeric fields safely. Order snapshots by parsed `completed_at`, then the string form of `cycle_id`, retaining input order as the final tie-breaker. The two latest valid snapshots form the current window.

When a snapshot omits `held_positions`, portfolio data may supply identity-only entries `{ address, symbol, current_price: null }`. Never use a live portfolio price in delta math.

#### Deterministic Delta

For a two-snapshot window, construct:

- `previous_cycle_id`
- `current_cycle_id`
- `previous_completed_at`
- `current_completed_at`
- `candidate_count_delta`
- `previous_top_composite_score`
- `current_top_composite_score`
- `top_composite_score_delta`, finite only when both endpoints are finite, otherwise `null`
- `new_approved_candidates`
- `held_position_price_changes`
- `max_abs_held_move_pct`

`new_approved_candidates` contains current approvals absent from the previous normalized-address set. Emit `{ address, symbol }`, deduplicate by trimmed lowercase address, and retain first occurrence in current-snapshot order.

For addresses in both held-position snapshots, emit `{ address, symbol, previous_price, current_price, abs_change_pct }` only when both prices are finite and the previous price is nonzero. Calculate:

`Math.abs(current_price - previous_price) / Math.abs(previous_price)`

Use current-snapshot order. Missing, non-finite, or zero baselines and missing/non-finite current prices are omitted. `max_abs_held_move_pct` is the maximum comparable move or `null`. A move is meaningful when `abs_change_pct >= threshold`.

#### Jev Request and Response

On every invocation having two valid snapshots and a nonblank trimmed `TYPESAFE_API_KEY`, initiate exactly one authenticated JSON POST to `https://api.typesafe.ai/v1/systemone`, with a 10000 ms abort timeout. Repeat the request even when the pair is unchanged.

`buildCadenceJevRequestBody({ previous, current, delta })` must produce:

- `model: "jev-latest"`
- `state: { previous, current, delta }`, with `previous` and `current` equal to the full snapshot `data` objects
- Questions exactly:

`run_early_cycle`:
- `type: "noul"`
- `instructions: "Is the delta sufficient to justify an early full Scout/Harvest cycle?"`
- criteria:
  - true: `"Material candidate-count, top-score, approval, or held-position changes justify pulling the cycle forward."`
  - false: `"The delta is empty or too small to justify an early Scout/Harvest cycle."`

`change_materiality`:
- `type: "score"`
- `instructions: "How material is the observed change to Scout/Harvest timing?"`
- criteria:
  - `"No Scout/Harvest timing relevance"`
  - `"Context only, no cadence impact"`
  - `"Indirect research or diagnostic relevance"`
  - `"Affects Scout/Harvest inputs but not enough to pull the cycle forward"`
  - `"Directly warrants an early full Scout/Harvest cycle"`

`dominant_driver`:
- `type: "choice"`
- `instructions: "Which observed change most strongly argues for an early cycle?"`
- options: `candidate_count`, `top_composite_score`, `new_approvals`, `held_position_move`
- criteria:
  - candidate_count: `"The cognitive-state candidate count changed enough to justify an early cycle."`
  - top_composite_score: `"The highest finite composite score changed enough to justify an early cycle."`
  - new_approvals: `"Newly approved candidates relative to the previous completed cycle dominate the case for an early cycle."`
  - held_position_move: `"Held-position price movement dominates the case for an early cycle."`

`normalizeCadenceJevResponse` must require matching answer types, a noul in `[0,1]`, score in `[0,4]`, score confidence in `[0,1]`, one allowed choice, and choice confidence in `[0,1]`. Any present probability map must be an object whose values are finite numbers in `[0,1]`. Return `{ noul, score, choice, score_confidence, choice_confidence }` or `null`.

`recommends_early_cycle` is true only for a normalized response with `noul >= 0.5`.

#### Shadow Verdict Telemetry

Append exactly one `shadow_verdict` per valid invocation, including invocations without sufficient history or Jev availability. Invalid CLI usage appends nothing.

Every verdict contains:

- `schema_version: 1`
- `record_type: "shadow_verdict"`
- `mode: "shadow"`
- UUID `verdict_id`
- `observed_at`
- `previous_cycle_id`
- `current_cycle_id`
- `source_cycle_window`
- `input_snapshot`
- `jev_attempted`
- `jev_available`
- normalized `noul`, `score`, `choice`, `score_confidence`, and `choice_confidence`
- `recommends_early_cycle`
- `reason`

For a two-snapshot window, IDs and timestamps come from the delta, `source_cycle_window` is `{ previous_completed_at, current_completed_at }`, and `input_snapshot` is the complete delta plus `meaningful_move_threshold`.

For fewer than two valid snapshots, use:

- `previous_cycle_id: null`
- `current_cycle_id`: the sole snapshot's cycle ID when exactly one exists, otherwise `null`
- `source_cycle_window: null`
- `input_snapshot: { meaningful_move_threshold }`
- all normalized values `null`
- `jev_attempted: false`
- `jev_available: false`
- `recommends_early_cycle: false`
- `reason: "insufficient_history"`

This is the only permitted reduced input snapshot; a complete delta is required whenever two snapshots exist.

Reason mapping is exact:

- `"ok"`: valid normalized response
- `"insufficient_history"`: fewer than two valid snapshots; no POST
- `"missing_credential"`: sufficient history but blank credential; no POST
- `"timeout"`: request aborted by the 10000 ms timeout
- `"http_failure"`: non-2xx response or non-timeout fetch/network rejection
- `"invalid_response"`: successful HTTP response with malformed JSON or failed normalization

`jev_attempted` is true exactly when sufficient history and a nonblank credential caused the POST to be initiated. `jev_available` is true only for `"ok"`.

Print one machine-readable JSON result to stdout, diagnostics to stderr, exit `1` if a required calibration append fails, and exit `0` otherwise.

#### Actual Outcomes

After successfully appending the verdict, consider the latest two-snapshot window. If its current cycle has no existing `actual_outcome`, append one containing:

- `schema_version: 1`
- `record_type: "actual_outcome"`
- current `cycle_id`
- `previous_cycle_id`
- `completed_at`
- deterministic `new_approved_candidates`
- `meaningful_held_moves`, retaining complete price-change entries whose move is at least the threshold
- `associated_verdict_ids`
- `meaningful_move_threshold`

Associate all existing shadow verdicts whose parseable `observed_at` is strictly greater than `previous_completed_at` and less than or equal to `current_completed_at`, preserving calibration-log order. Use `[]` when none qualify. Do not invent verdicts.

Reconstruct processed cycle IDs from valid `actual_outcome` records so repeated invocations cannot duplicate an outcome. A failed outcome append causes exit `1`; a previously successful verdict remains append-only.

#### Cron Wrappers

Create install/remove wrappers following the existing portfolio-snapshot cron pattern.

The installer defaults to `*/15 * * * *`, supports `--print`, `--dry-run`, and help, and resolves:

- `JEV_CADENCE_REPO_DIR`
- `JEV_CADENCE_NODE_BIN`
- `JEV_CADENCE_CRONTAB_BIN`
- `JEV_CADENCE_CRON_LOG`, defaulting to `$REPO_DIR/logs/jev-cycle-cadence-gate.log`
- `JEV_CADENCE_CRON_SCHEDULE`

Cron line:

`$CRON_SCHEDULE cd $REPO_DIR && $NODE_BIN $REPO_DIR/scripts/jevCycleCadenceGate.js >> $CRON_LOG 2>&1`

Preserve unrelated entries and install idempotently by identifying `jevCycleCadenceGate.js`.

The remover supports `--dry-run` and help, removes only that sidecar entry, preserves unrelated entries, and reports `not installed` idempotently.

Neither wrapper may reference a pipeline start command or the Qwen runner.

#### Verification

Create `scripts/verifyJevCycleCadenceGate.js` with temporary fixtures, `fileURLToPath`, and injected paths, time, and fetch behavior. Verify:

- Exact URL, bearer authentication, model, full state objects, and exact question schema.
- Strict normalization acceptance/rejection, including noul `0.49` false and `0.5` true.
- Candidate-count and top-score deltas, including null top-score deltas.
- Lowercase address comparison, deterministic deduplication, and exact candidate shape.
- Price calculations, omissions, and inclusive 5% boundary.
- Exact `(previous_completed_at, current_completed_at]` association.
- The explicitly defined zero-snapshot and one-snapshot verdict shapes.
- Repeated-run outcome idempotency.
- Missing credentials, timeout, non-2xx failure, network rejection, malformed JSONL, malformed response JSON, and invalid normalized responses.
- Exact reason mapping, attempted/available flags, and no credential leakage.
- No portfolio or pipeline writes and no pipeline import, execution, spawn, signal, trigger, skip, or scheduling-control path.

Create `scripts/verifyJevCycleCadenceCron.js` with an isolated fake crontab and `fileURLToPath`. Verify exact 15-minute output, print/dry-run behavior, installation, repeated installation, removal, repeated removal, unrelated-entry preservation, and absence of pipeline and Qwen commands.

#### Package Scripts

Add:

- `jev:cadence`: `node scripts/jevCycleCadenceGate.js`
- `jev:cadence:verify`: `node scripts/verifyJevCycleCadenceGate.js`
- `jev:cadence:cron:print`: `bash scripts/installJevCycleCadenceCron.sh --print`
- `jev:cadence:cron:install`: `bash scripts/installJevCycleCadenceCron.sh`
- `jev:cadence:cron:remove`: `bash scripts/removeJevCycleCadenceCron.sh`

Extend, without removing existing checks, `npm run check` with `node --check` for the three new JavaScript files and execution of both new verification scripts.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Two snapshots yield correct deterministic deltas and meaningful moves without market-data requests.
- Jev uses the cadence questions and strict Noul/Score/Choice bounds.
- Initial history produces the explicitly defined reduced verdict telemetry.
- Repeated processing cannot duplicate an actual outcome.
- Outcomes reference exactly the verdicts in their real-cycle intervals.
- Missing or failed Jev access produces telemetry without affecting the pipeline.
- Cron runs only the cadence sidecar every 15 minutes.
- No implementation path changes cycle control.
- Verification does not modify protected tracked runtime data.
