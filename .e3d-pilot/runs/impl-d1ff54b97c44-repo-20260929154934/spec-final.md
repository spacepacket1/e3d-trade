# Jev Shadow-Mode Recurring Improvement Gate

## Overview

Add a dependency-free Node.js pre-screen CLI for recurring e3d-pilot discover/ideate runs against this repository. It computes a composite change fingerprint, makes at most one typed Jev request, and emits a calibration-ready shadow verdict. Shadow mode always permits the scheduled full pass.

## Goals

- Fingerprint repository, performance, attribution, and prior-ideation changes deterministically.
- Ask Jev one Noul, one Score, and one Choice question in a single request.
- Fail open when credentials, inputs, reports, or Jev are unavailable.
- Enforce a 14-day maximum interval recommendation.
- Emit machine-readable calibration data without leaking credentials.
- Provide deterministic offline verification.

## Non-Goals

- Skipping discover/ideate runs.
- Scheduling or modifying e3d-pilot itself.
- Persisting runtime state or calibration logs inside this repository.
- Assessing false-skip rates or promoting the gate from shadow mode.
- Changing trading, risk, execution, training, report-generation, or portfolio behavior.

## Existing Files

- `package.json` defines ESM scripts and the configured `check` workflow.
- `scripts/performanceDaily.js` writes `reports/performance-daily-*.json` objects whose `report_type` is `daily_performance`.
- `scripts/signalAttribution.js` writes `reports/attribution/signal-attribution-*.json` objects whose `report_type` is `signal_attribution_expectancy`.
- `.codex-spec-runner/manifest.tsv` identifies `codex:gpt-5.4` as the most recent successfully completed model.
- `scripts/jevRecurringGate.js` and `scripts/verifyJevRecurringGate.js` do not yet exist.

## Shared Constraints

- Keep the implementation within three changed files and 400 changed lines.
- Use only Node.js built-ins and the existing runtime; add no dependency.
- Read report data without modifying `reports/**` or any other protected path.
- Never write persistent state. The caller supplies the prior snapshot and owns persistence.
- Use `TYPESAFE_API_KEY` only in the server-side Authorization header, as `Bearer <key>`.
- Use the official System One endpoint and typed request shape documented by the [TypeSafe Jev quickstart](https://www.typesafeai.org/guides/jev-api-quickstart): `POST https://api.typesafe.ai/v1/systemone` with `model`, `state`, and a `questions` map. Question `type` values are lowercase `noul`, `score`, and `choice`.
- One invocation may make zero or one Jev request, never retries, including on 429 or 529.
- All diagnostic text goes to stderr. Stdout contains exactly one JSON document, optionally followed by a single trailing newline, suitable for capture by e3d-pilot.
- Never put the API key, Authorization header, absolute paths, full reports, or response body in stdout, stderr, errors, or the Jev state.

## Phase 1 - Implement and Verify the Shadow Gate
<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/jevRecurringGate.js -->
<!-- pilot:touches=scripts/verifyJevRecurringGate.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/performanceDaily.js -->
<!-- runner:read=scripts/signalAttribution.js -->
<!-- runner:read=package.json -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Create `scripts/jevRecurringGate.js` as an importable ESM module and a directly executable CLI. Do not call the network at import time. Use global `fetch` only from the run path so tests can replace `globalThis.fetch`.

2. Accept only these optional CLI flags. Unknown flags, or a flag without its value, are invalid usage.

   - `--root <dir>`: repository root. Default: `process.cwd()`.
   - `--previous <file>`: previous snapshot JSON path. Absent means there is no previous snapshot.
   - `--last-ideate-sha <sha>`: last ideate digest SHA. Absent or blank is a missing component.
   - `--last-full-pass <timestamp>`: last completed full-pass time.
   - `--now <timestamp>`: deterministic current time. Default: the current clock.

   Timestamps must be ISO-8601 strings that `Date.parse` accepts and that include `Z` or an explicit numeric offset. Missing or invalid optional inputs, including an unparseable `--now` or `--last-full-pass`, produce a fail-open verdict and exit 0. They must not throw. Invalid usage exits 2 only after writing the same safe JSON document to stdout.

3. Build snapshot version `1` containing:

   - `head_sha`: stdout of `git rev-parse HEAD` in `--root`, trimmed. Any failure or empty output is `null`. Do not hash the worktree or use the current time.
   - `performance_daily_row_count`: the number of non-recursive `reports/performance-daily-*.json` files under `--root` that parse as JSON objects with `report_type === "daily_performance"`. This is a file count, not a sum of rows inside reports. An unreadable reports directory makes the count `null`. Zero matching files is the number `0`, not missing.
   - `signal_attribution_checksum`: SHA-256 hex of the canonical JSON of the selected attribution report, or `null` when none qualifies. Consider only non-recursive `reports/attribution/signal-attribution-*.json` files that parse as JSON objects with `report_type === "signal_attribution_expectancy"`. Select the greatest `generated_at` string by `localeCompare`; break ties, including missing `generated_at`, by the lexicographically greatest basename. Enumerate basenames in sorted order before parsing. Never use filesystem mtime.
   - `last_ideate_digest_sha`: the trimmed CLI value, or `null` when absent or blank.
   - `fingerprint`: SHA-256 hex of the canonical JSON of those four fields, using `null` for every missing component.

   Canonical JSON uses `JSON.stringify` for null, booleans, finite numbers, and strings. Arrays keep their order. Objects sort keys lexicographically, omit keys whose value is `undefined`, and contain no insignificant whitespace. The snapshot is incomplete when any of the four component values is `null`. Do not substitute mtime, a random value, or the current time for a missing component.

4. A previous snapshot is usable only when `--previous` names a readable JSON object that contains the four component fields. Otherwise the run is an initial snapshot. Compare usable snapshots with canonical equality and return the changed component names sorted lexicographically. The Jev `state` object contains only `previous` components, `current` components, and `changed_components`. Do not send full reports, credentials, absolute paths, fingerprints of unrelated files, or other repository content.

5. Send a request only when the key is non-blank, the current snapshot is complete, and the previous snapshot is usable. Hard-max forcing does not suppress that request. Otherwise make zero requests.

   When sending, make exactly one `POST` to `https://api.typesafe.ai/v1/systemone` with `Content-Type: application/json`, `Authorization: Bearer <TYPESAFE_API_KEY>`, a 10000 ms timeout, `model: "jev-latest"`, the bounded state, and this `questions` object:

   - `run_full_pass`: type `noul`. Instructions: `Is the delta sufficient to justify a full multi-provider discover/ideate pass?` Criteria: `true` means material repository, performance, attribution, or ideation changes justify a full pass; `false` means the delta is empty or irrelevant to a full discover/ideate pass.
   - `pnl_relevance`: type `score`. Instructions: `How relevant is the delta to trading profit and loss?` Criteria, in order: `No P&L relevance`; `Context only, no decision impact`; `Indirect research or diagnostic relevance`; `Affects a trading input but not the order path`; `Direct entry, exit, sizing, or execution-cost impact`.
   - `profit_loop`: type `choice`. Instructions: `Which profit-loop stage does the delta most directly affect?` Criteria: `entry` means it changes whether a position is opened or the entry signal; `harvest_exit` means it changes whether or when an open position is closed; `sizing` means it changes position size or exposure without itself changing the entry or exit signal; `execution_cost` means it changes expected fees, slippage, liquidity, or other execution cost.

   Do not retry. A blank or absent `TYPESAFE_API_KEY` makes no request.

6. Validate the response defensively and all-or-nothing. Require HTTP 2xx and a JSON object whose `answers` contain all three ids with matching lowercase types. `run_full_pass.noul` must be a finite number from 0 through 1. Noul has no confidence field; do not require one. `pnl_relevance.score` must be a finite number from 0 through 4, and its `confidence` a finite number from 0 through 1. `profit_loop.choice` must be one of `entry`, `harvest_exit`, `sizing`, and `execution_cost`, and its `confidence` a finite number from 0 through 1. If a probability map is present, every value must be a finite number from 0 through 1; a missing probability map is acceptable. Treat timeout or abort as `timeout`; other network failures and non-2xx responses as `http_failure`; malformed JSON, missing answers, type mismatches, and out-of-range values as `invalid_response`. Never copy the response body or API key into the result or diagnostics.

7. Emit this JSON object and no other stdout:

   - `schema_version`: `1`.
   - `calibration_id`: SHA-256 hex of the canonical snapshot component object. It does not include the clock, credential, or paths.
   - `snapshot`: the versioned snapshot, with `null` components when unavailable.
   - `changed_components`: sorted names, or an empty array when the previous snapshot is not usable.
   - `mode`: `"shadow"`.
   - `jev_attempted` and `jev_available`: booleans.
   - `noul`, `score`, `choice`, `score_confidence`, and `choice_confidence`: normalized values when the whole response is valid, otherwise `null`. Do not emit a Noul confidence.
   - `gate_recommends_full_pass`: `true` only when `jev_available` is true and `noul >= 0.5`; otherwise `false`.
   - `forced_by_hard_max_interval`: `true` when `--last-full-pass` is absent, invalid, lacks a timezone, or is at least 14 days before a valid `--now`. The boundary is inclusive: elapsed milliseconds `>= 14 * 86400000`. A future last pass is not forced. An invalid `--now` forces the flag because the interval cannot be shown to be under 14 days.
   - `would_run_full_pass`: `false` only when the reason is `jev_signal`, `gate_recommends_full_pass` is false, and `forced_by_hard_max_interval` is false. Every other result is `true`.
   - `actual_full_pass_required`: `true` on every path, including invalid usage and fail-open results.
   - `reason`: exactly one of `invalid_usage`, `incomplete_snapshot`, `initial_snapshot`, `missing_credential`, `timeout`, `http_failure`, `invalid_response`, `hard_max_interval`, or `jev_signal`, using that precedence.
   - `calibration`: `gate_verdict` equal to `would_run_full_pass`, `actual_full_pass_ran` true, and `shippable_idea` null.

   Precedence means the first applicable code wins. In particular, a valid Jev answer whose interval is already forced uses `hard_max_interval`, while still retaining the normalized answers and the threshold recommendation. Missing credentials, incomplete snapshots, and initial snapshots make no request even when the interval is also forced.

8. A missing credential returns exit 0 and makes no network request. Timeout, HTTP failure, and invalid response also exit 0. Only invalid CLI usage exits nonzero, and it still exits 2 after the JSON document. No path may throw out of the CLI.

9. Export pure helpers for canonical serialization, fingerprint construction, snapshot comparison, interval evaluation, request-body construction, response normalization, and verdict construction. Verification must be able to exercise them without live services, credentials, Git, or protected repository data.

10. Create `scripts/verifyJevRecurringGate.js` using Node assertions and temporary fixture directories. Cover:

    - stable fingerprints despite JSON key order and report enumeration order;
    - fingerprint changes for each of the four components;
    - attribution selection by `generated_at`, basename tie-break, and skipping malformed or wrong-type reports;
    - performance counting as matching file count, excluding malformed files, with zero represented as `0`;
    - first-run and incomplete-input fail-open behavior with no fetch;
    - missing or blank key behavior with zero fetch calls and exit 0;
    - one mocked request whose body uses `jev-latest` and the three question ids, lowercase types, five score levels, and four choice options, with a Bearer header and no credential in the state;
    - valid response normalization, including a Noul answer without confidence and a fractional score inside 0 through 4;
    - timeout, non-2xx, malformed JSON, and invalid typed-answer fallbacks, each with exit 0 and no second fetch;
    - the 14-day boundary at one millisecond below, exactly on, and above the boundary;
    - shadow mode always setting `actual_full_pass_required` to true, including when `would_run_full_pass` is false;
    - stdout as one parseable JSON document, diagnostics on stderr, and absence of a supplied sentinel credential from both streams.

11. Update `package.json` with `jev:gate` running `node scripts/jevRecurringGate.js` and `jev:verify` running `node scripts/verifyJevRecurringGate.js`. Append syntax checks for both new files and `jev:verify` to the existing `check` script. Do not alter unrelated scripts, script order, or dependencies.

### Acceptance Criteria

- `npm install && npm run check` succeeds without a live credential or network access.
- Identical normalized inputs always yield the same composite fingerprint.
- Changing any fingerprint component changes the fingerprint.
- A keyed valid evaluation performs exactly one request containing Noul, Score, and Choice questions in the documented shape.
- Missing credentials and every tested Jev failure produce a successful fail-open result and do not retry.
- At exactly 14 days and later, `forced_by_hard_max_interval` and `would_run_full_pass` are true. One millisecond earlier, the hard-max flag is false unless the timestamp is absent or invalid.
- `gate_recommends_full_pass` is true only for an available Noul value of at least 0.5.
- Every result has `mode: "shadow"` and `actual_full_pass_required: true`; no code path skips a run.
- Stdout is one parseable JSON document, diagnostics remain on stderr, and credentials never appear in either stream.
- No protected path is modified.
- The total implementation remains within three files and 400 changed lines.
