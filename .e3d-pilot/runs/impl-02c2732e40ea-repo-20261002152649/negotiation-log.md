---
run_id: impl-02c2732e40ea-repo-20261002152649
---

# Negotiation Log

## Round 1

### Draft Before Round

```text
# Profit-Taking Calibration Cohort

## Overview

Add an idempotent calibration workflow that compares deterministic profit-taking exits with the counterfactual result of holding each exited quantity for 24 and 48 hours. The workflow reads closed trades from `portfolio.json`, records append-only calibration snapshots at runtime, emits cohort summaries, exposes recent summaries through the server, and displays the latest results in the Reports tab.

## Goals

- Measure `stop_loss`, `target_[1-3]`, and `manual_operator*` exits against 24-hour and 48-hour hold counterfactuals.
- Reuse the E3D `/token-info/<address>` price-fetch mechanism from `scripts/recordOutcomes.js`.
- Preserve an append-only, idempotent runtime ledger.
- Produce machine-readable summaries for `stop_loss`, `target_hit`, and `manual_action`.
- Add an hourly cron integration consistent with the existing record-outcomes scripts.
- Expose recent reports through the local API and dashboard.
- Add deterministic regression coverage for cohort selection, horizon gating, and portfolio immutability.

## Non-Goals

- Changing stop distances, target multiples, partial-take fractions, or trading decisions.
- Distinguishing initial stops from trailing stops.
- Adding CoinGecko, DexScreener, or another price source.
- Changing Scout, Harvest, Risk, sizing, execution, or cooldown behavior.
- Writing to `portfolio.json`.
- Migrating existing closed trades or pre-populating generated artifacts in source control.
- Introducing a report-listing framework, database, frontend framework, or external dependency.

## Existing Files

- `scripts/recordOutcomes.js` contains the existing authenticated E3D token-price fetch and horizon-gating pattern.
- `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh` define the repository’s cron installation conventions.
- `pipeline.js` defines the closed-trade schema. Sell records use `ts`, `price`/`fill_price`, `quantity`, `pnl_usd`, and `cost_portion_usd`.
- `server.js` contains report-directory constants, report readers, summary functions, and `/api/attribution/reports`.
- `dashboard/app.js` contains Reports-tab state, loading, error, and panel patterns.
- `package.json` contains runnable commands and the repository-wide `check` command.
- `portfolio.json` is an input only and must remain byte-for-byte unchanged.

## Shared Constraints

- Keep the implementation within 15 changed files and 1600 changed lines.
- Do not edit, create, delete, rename, or commit any file under the protected paths. Runtime execution may generate the specified calibration ledger and report files, but implementation phases must touch source files only.
- Treat `portfolio.json` as strictly read-only.
- Add no runtime or development dependencies.
- Use ESM and the repository’s existing Node.js style.
- Use `execFileSync("curl", ...)`, `E3D_API_BASE_URL`, `E3D_API_KEY`, `/token-info/<encoded-address>`, and the price-field fallbacks already used by `fetchTokenPrice()` in `scripts/recordOutcomes.js`.
- Do not expose API credentials in output, reports, errors, or tests.
- A valid fetched price must be finite and greater than zero.
- Use UTC ISO timestamps and deterministic numeric calculations.
- Preserve unrelated working-tree changes.
- `npm install && npm run check` must pass after every phase.

## Phase 1 - Calibration Ledger, Summary, Scheduling, and Regression Coverage

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/profitTakeCalibration.js -->
<!-- pilot:touches=scripts/verifyProfitTakeCalibration.js -->
<!-- pilot:touches=scripts/installProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=scripts/removeProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/recordOutcomes.js -->
<!-- runner:read=scripts/installRecordOutcomesCron.sh -->
<!-- runner:read=scripts/removeRecordOutcomesCron.sh -->
<!-- runner:read=pipeline.js -->
<!-- runner:read=package.json -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Create `scripts/profitTakeCalibration.js` with exported, independently testable functions and a direct-execution entry point.

2. Implement cohort classification using the stored exit reason:

   - Exactly `stop_loss` maps to `stop_loss`.
   - Exactly `target_1`, `target_2`, or `target_3` maps to `target_hit`.
   - Any string beginning with `manual_operator` maps to `manual_action`.
   - All other reasons are excluded.

3. Read `portfolio.json` only through a configurable input path whose production default is the repository-root file. Process only `closed_trades` entries that:

   - Match a calibration cohort.
   - Have a non-empty `trade_id`, contract address, and parseable exit timestamp.
   - Have finite `quantity`, realized `pnl_usd`, and cost basis.
   - Resolve cost basis from `cost_basis_usd` when present, otherwise from the repository’s actual `cost_portion_usd` field.
   - Resolve exit price from `fill_price` when valid, otherwise `price`.

   Invalid records must be skipped with a concise warning and must not abort valid records.

4. Represent each calibrated trade with the following normalized fields:

   ```json
   {
     "trade_id": "string",
     "symbol": "string",
     "contract_address": "string",
     "exit_reason": "string",
     "exit_cohort": "stop_loss|target_hit|manual_action",
     "exit_ts": "ISO8601",
     "exit_price": 0,
     "quantity": 0,
     "pnl_usd": 0,
     "cost_basis_usd": 0,
     "hold_price_24h": null,
     "hold_price_48h": null,
     "beat_hold_24h": null,
     "beat_hold_48h": null,
     "recorded_at": "ISO8601"
   }
   ```

5. At runtime, use `logs/profit-take-calibration.jsonl` as an append-only ledger. Do not rewrite or truncate it.

   - Load valid JSONL rows and select the last valid row for each `trade_id` as its current snapshot.
   - Append one initial snapshot for each eligible trade not already represented.
   - When a horizon becomes available, append a complete replacement snapshot for that trade while retaining all previously populated fields.
   - Ignore malformed ledger lines with a warning rather than destroying valid history.
   - Never append an unchanged snapshot.
   - Ensure duplicate closed trades or repeated runs cannot create duplicate initial snapshots.

6. Implement independent horizon gating using an injectable clock:

   - A null 24-hour price becomes eligible once `now - exit_ts >= 24 hours`.
   - A null 48-hour price becomes eligible once `now - exit_ts >= 48 hours`.
   - A populated horizon is never fetched or overwritten.
   - A trade crossing 48 hours after its 24-hour value was populated fetches only the missing 48-hour value.
   - If multiple missing horizons are eligible on one run, fetch the token once and apply that observation to each newly eligible horizon.
   - A failed or invalid fetch leaves eligible fields null so a later invocation can retry.

7. Duplicate the price-fetch behavior from `scripts/recordOutcomes.js` without adding another data source. Preserve its URL encoding, timeout behavior, bearer authorization, and supported response-field fallbacks.

8. For each populated horizon, calculate:

   - `counterfactual_hold_pnl_usd = quantity * hold_price - cost_basis_usd`
   - `delta_usd = pnl_usd - counterfactual_hold_pnl_usd`
   - `beat_hold = pnl_usd > counterfactual_hold_pnl_usd`

   Store only the required price and boolean fields in ledger snapshots; derive counterfactual values and deltas for reports.

9. When and only when a run appends at least one initial or horizon snapshot, emit a JSON summary at runtime under `reports/profit-take-calibration/` using `profit-take-calibration-YYYYMMDD-HHMMSS.json`.

   The report must include:

   - `report_type: "profit_take_calibration"`
   - A stable `report_id`
   - `generated_at`
   - Total distinct calibrated trades
   - Counts with 24-hour data, 48-hour data, and both horizons complete
   - A `cohorts` object with keys `stop_loss`, `target_hit`, and `manual_action`
   - For each cohort and each horizon: evaluated count, beat-hold count, beat-hold rate percentage, average delta USD, and median delta USD
   - A both-horizons-complete count for each cohort

   Empty cohorts must remain present with zero counts and null rates/averages/medians. Median must be the middle sorted value for odd samples and the mean of the two middle values for even samples.

10. A run with no new trades and no newly available successful horizon observations must not modify the ledger or create a duplicate report.

11. Create hourly install/remove scripts matching the behavior and safety of the record-outcomes cron scripts.

   - Default schedule: `0 * * * *`.
   - Invoke `node scripts/profitTakeCalibration.js` from the repository root.
   - Support idempotent detection, `--dry-run`, and installation output; the installer must also support `--print`.
   - Use calibration-specific environment override names.
   - Do not install or remove a cron entry during implementation or verification.

12. Add package scripts for direct execution and cron print/install/remove operations. Extend the existing `check` command to syntax-check the new JavaScript files and execute `scripts/verifyProfitTakeCalibration.js`.

13. Create `scripts/verifyProfitTakeCalibration.js` using temporary fixtures and injected paths, clock, and price fetcher. It must test:

   - All included and excluded reason values from the candidate.
   - Initial ingestion and cohort normalization.
   - Duplicate ingestion and repeated-run idempotency.
   - A trade younger than 24 hours remains unchanged without a fetch.
   - An eligible 24-hour row with an existing value is not re-fetched.
   - A row crossing 48 hours with 24-hour data fills only the 48-hour fields.
   - A late first run with both horizons missing performs one fetch.
   - Failed fetches remain retryable.
   - Strict beat-hold comparison and average/median summary calculations.
   - Malformed ledger data does not erase valid rows.
   - An unchanged run creates neither ledger additions nor a report.
   - Any attempted write, append, rename, or truncation targeting the portfolio input fails the test, and the fixture’s bytes remain unchanged after a full run.

### Acceptance Criteria

- The script recognizes only the three specified exit cohorts.
- The production price request is behaviorally consistent with `scripts/recordOutcomes.js`.
- Ledger history is append-only and current state is reconstructed from the last snapshot per trade.
- Horizon observations are independent, retryable, and idempotent.
- Report metrics use realized P&L minus counterfactual hold P&L.
- No implementation or test path writes to `portfolio.json`.
- Cron scripts are printable, idempotent, and are not activated by tests.
- No generated ledger or report is committed.
- `npm install && npm run check` succeeds.

## Phase 2 - Report API and Reports-Tab Panel

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=dashboard/app.js -->
<!-- runner:read=server.js -->
<!-- runner:read=dashboard/app.js -->
<!-- runner:read=scripts/profitTakeCalibration.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Extend `server.js` using the existing attribution-report pattern:

   - Add a constant for the runtime `reports/profit-take-calibration` directory.
   - Add a narrowly scoped report-listing function; do not introduce a shared report abstraction.
   - Accept only filenames matching `profit-take-calibration-YYYYMMDD-HHMMSS.json`.
   - Parse through the existing safe report reader.
   - Retain only objects with `report_type === "profit_take_calibration"`.
   - Sort newest first using `generated_at`.
   - Add a summary function that exposes the report identity, timestamp, aggregate completion counts, and all three cohort metric objects without credentials, filesystem paths, or unrelated fields.

2. Add `GET /api/profit-take-calibration/reports`.

   - Return at most the 30 newest summarized reports as a JSON array.
   - Return `[]` with HTTP 200 when the directory is absent or contains no valid reports.
   - Follow existing `sendJson` routing and error-handling conventions.
   - Do not generate reports from the request handler.

3. Extend `dashboard/app.js` with Reports-tab state and loading behavior for the new endpoint.

   - Fetch the endpoint when the Reports page is selected, following the existing page-load pattern.
   - Keep calibration loading and errors isolated from Manager report loading.
   - Use the newest returned report as the displayed summary.
   - Do not add a frontend dependency or a new navigation page.

4. Add a Profit-Take Calibration section to the Reports tab using existing card, panel, grid, badge, currency, percentage, loading, error, and empty-state styles.

   - Show the report timestamp and total distinct trade count.
   - Show overall 24-hour, 48-hour, and both-horizons completion counts.
   - Show one row or compact card for each of `stop_loss`, `target_hit`, and `manual_action`.
   - For both 24 and 48 hours, show evaluated count, beat-hold rate, and average delta USD.
   - Render unavailable rates and deltas as an em dash.
   - Make positive, negative, zero, loading, empty, and API-error states understandable without inspecting raw JSON.
   - Use human-readable labels: “Stop Loss,” “Target Hit,” and “Manual Action.”

5. Keep changes local to report discovery, the new GET route, Reports-tab fetching, and rendering. Do not alter report generation, portfolio state, trading behavior, or existing report panels.

### Acceptance Criteria

- The endpoint returns newest-first, bounded, summarized calibration reports.
- Missing or malformed runtime report data degrades to an empty array rather than crashing the server.
- The Reports tab fetches and renders the latest calibration report.
- Every cohort displays 24-hour and 48-hour evaluated count, beat-hold rate, and average USD delta.
- Existing Manager reports and other dashboard panels continue to work.
- No protected path is modified or committed.
- `npm install && npm run check` succeeds.

```

### Reviewer 1: grok-build

Status: revise

Reason: Closed trades store reason and ts, and the report contract never defines cumulative metrics, same-run snapshot cardinality, or field names.

Replacement Spec:

```spec
# Profit-Taking Calibration Cohort

## Overview

Add an idempotent calibration workflow that compares deterministic profit-taking exits with the counterfactual result of holding each exited quantity for 24 and 48 hours. A horizon observation is the spot price returned by the existing E3D token-info endpoint at the first successful fetch after that horizon elapses. The workflow reads closed trades from `portfolio.json`, records append-only calibration snapshots at runtime, emits cumulative cohort summaries, exposes recent summaries through the server, and displays the latest results in the Reports tab.

## Goals

- Measure `stop_loss`, `target_1`, `target_2`, `target_3`, and `manual_operator*` exits against 24-hour and 48-hour hold counterfactuals.
- Reuse the E3D `/token-info/<address>` price-fetch mechanism from `scripts/recordOutcomes.js` by duplicating it locally.
- Preserve an append-only, idempotent runtime ledger.
- Produce machine-readable cumulative summaries for `stop_loss`, `target_hit`, and `manual_action`.
- Add an hourly cron integration consistent with the existing record-outcomes scripts.
- Expose recent reports through the local API and dashboard.
- Add deterministic regression coverage for cohort selection, horizon gating, summary math, and portfolio immutability.

## Non-Goals

- Changing stop distances, target multiples, partial-take fractions, or trading decisions.
- Distinguishing initial stops from trailing stops.
- Adding CoinGecko, DexScreener, a historical candle API, or another price source.
- Changing Scout, Harvest, Risk, sizing, execution, or cooldown behavior.
- Writing to `portfolio.json`.
- Migrating existing closed trades or pre-populating generated artifacts in source control.
- Introducing a report-listing framework, database, frontend framework, or external dependency.
- Importing `scripts/recordOutcomes.js`. Loading that module executes its CLI.

## Existing Files

- `scripts/recordOutcomes.js` contains the authenticated E3D token-price fetch. `fetchTokenPrice()` requests `${E3D_API_BASE_URL}/token-info/${encodeURIComponent(address)}` with `execFileSync("curl", ["-s", "--max-time", "15", url, ...optional bearer header], { encoding: "utf8", timeout: 20000 })`. The bearer header is `Authorization: Bearer ${E3D_API_KEY}` and is sent only when `E3D_API_KEY` is non-empty. The base URL defaults to `https://e3d.ai/api`. The accepted response fields, in order, are `priceUSD`, `price_usd`, `current_price`, and `market_data.current_price.usd`.
- Closed sells are appended to `portfolio.closed_trades` by `executeSell()` in `pipeline.js`. The source fields are `trade_id`, `symbol`, `contract_address`, `side` (`sell`), `reason`, `ts`, `quantity`, `price`, `fill_price`, `pnl_usd`, and `cost_portion_usd`. There is no `exit_reason`, `exit_ts`, or `cost_basis_usd` field on those records. `reason` is exactly `stop_loss`, `target_1`, `target_2`, `target_3`, or the operator string, whose default is `manual_operator_action`.
- `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh` define the cron installation conventions, including `--dry-run`, installer `--print`, idempotent detection, and environment overrides.
- `server.js` contains report-directory constants, `readReportFile()`, per-directory listing functions, summary functions, and `GET /api/attribution/reports`.
- `dashboard/app.js` loads the Reports tab through `loadReports()` when `page === "reports"`, with separate loading and error state.
- `package.json` contains the runnable commands and the repository-wide `check` command.
- `portfolio.json` is an input only and must remain byte-for-byte unchanged.

## Shared Constraints

- Keep the implementation within 15 changed files and 1600 changed lines.
- Phase 1 may change only `scripts/profitTakeCalibration.js`, `scripts/verifyProfitTakeCalibration.js`, `scripts/installProfitTakeCalibrationCron.sh`, `scripts/removeProfitTakeCalibrationCron.sh`, and `package.json`. Phase 2 may change only `server.js` and `dashboard/app.js`.
- Runtime execution of the calibration CLI may create `logs/profit-take-calibration.jsonl` and `reports/profit-take-calibration/profit-take-calibration-YYYYMMDD-HHMMSS.json`. Verification must redirect those writes to temporary directories. Do not commit generated ledgers or reports.
- Treat `portfolio.json` as strictly read-only.
- Add no runtime or development dependencies.
- Use ESM and the repository’s existing Node.js style.
- Duplicate the `fetchTokenPrice()` curl invocation locally. Do not import `scripts/recordOutcomes.js`.
- Do not expose API credentials, authorization headers, or response bodies in output, reports, errors, or tests.
- A valid fetched price is a finite number greater than zero after `Number()` coercion of the first present fallback field. Any other result is a failed fetch.
- Use UTC ISO-8601 timestamps from `Date.prototype.toISOString()` and exact millisecond horizons: 24 hours is `86400000` ms and 48 hours is `172800000` ms.
- Preserve unrelated working-tree changes.
- `npm install && npm run check` must pass after every phase.

## Phase 1 - Calibration Ledger, Summary, Scheduling, and Regression Coverage

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/profitTakeCalibration.js -->
<!-- pilot:touches=scripts/verifyProfitTakeCalibration.js -->
<!-- pilot:touches=scripts/installProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=scripts/removeProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/recordOutcomes.js -->
<!-- runner:read=scripts/installRecordOutcomesCron.sh -->
<!-- runner:read=scripts/removeRecordOutcomesCron.sh -->
<!-- runner:read=pipeline.js -->
<!-- runner:read=package.json -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Create `scripts/profitTakeCalibration.js` with exported functions and a direct-execution entry point. Export `classifyExitCohort(reason)` and `runProfitTakeCalibration(options)`. The CLI calls `runProfitTakeCalibration()` with production defaults. `options` accepts `portfolioPath`, `ledgerPath`, `reportsDir`, `now`, `fetchPrice`, and `env`. `now()` returns epoch milliseconds and defaults to `Date.now`. `fetchPrice(address)` returns a finite price or `null` and defaults to the local token-info fetch. Production paths are the repository-root `portfolio.json`, `logs/profit-take-calibration.jsonl`, and `reports/profit-take-calibration/`.

2. Implement case-sensitive cohort classification from the closed trade’s `reason` string:

   - Exactly `stop_loss` maps to `stop_loss`.
   - Exactly `target_1`, `target_2`, or `target_3` maps to `target_hit`.
   - A string whose first characters are `manual_operator` maps to `manual_action`.
   - Every other value, including `stop`, `STOP_LOSS`, `target_4`, `manual`, `stub_flatten`, `fraud_risk_breach`, and `non_tradeable_force_exit`, maps to `null` and is excluded.

3. Read `portfolio.json` only through `portfolioPath`. Parse it once per run. A missing file or invalid top-level JSON makes `runProfitTakeCalibration` throw, and the CLI exits 1. A valid portfolio with no eligible trades is a successful no-op. Process objects in `closed_trades` whose `side` is `sell` or absent. Skip a record, with one concise stderr warning that contains no credential material, when any of the following is true:

   - `classifyExitCohort(reason)` is `null`.
   - Trimmed `trade_id` or trimmed `contract_address` is empty.
   - `ts` does not parse to a finite timestamp.
   - `quantity` is not a finite number greater than zero.
   - `pnl_usd` is not finite.
   - Cost basis is not finite. Use `cost_basis_usd` when it is finite, including zero; otherwise use `cost_portion_usd`.
   - Exit price is not finite and greater than zero. Use `fill_price` when it is valid; otherwise use `price`.

   Skipping a record must not prevent later valid records from being processed. A missing `symbol` becomes an empty string.

4. Represent each calibrated trade with these normalized fields, in this order:

    {
      "trade_id": "string",
      "symbol": "string",
      "contract_address": "string",
      "exit_reason": "string",
      "exit_cohort": "stop_loss|target_hit|manual_action",
      "exit_ts": "ISO8601 from trade.ts",
      "exit_price": 0,
      "quantity": 0,
      "pnl_usd": 0,
      "cost_basis_usd": 0,
      "hold_price_24h": null,
      "hold_price_48h": null,
      "beat_hold_24h": null,
      "beat_hold_48h": null,
      "recorded_at": "ISO8601 from now()"
    }

   `exit_reason` stores the original `reason` string. `exit_cohort` stores the classified cohort.

5. Use `ledgerPath` as an append-only JSONL ledger. Do not rewrite, sort, or truncate it. Create its parent directory only when appending.

   - Load valid JSON objects and select the last valid object for each `trade_id` as its current snapshot.
   - Ignore malformed lines and non-object rows with a stderr warning. Keep every valid row.
   - Portfolio records whose `trade_id` already has a snapshot are not used to change exit fields.
   - For each eligible portfolio trade without a snapshot, build the initial snapshot and fill every horizon that is already eligible in this same run.
   - For an existing snapshot, append a replacement only when at least one horizon moves from `null` to a valid price in this run. Copy all previously populated fields forward.
   - A run appends at most one new line per `trade_id`.
   - `recorded_at` is set from `now()` on the appended line. Snapshot equality ignores `recorded_at`.
   - Duplicate `closed_trades` rows and repeated runs must not create a second initial snapshot for the same `trade_id`.

6. Gate each horizon independently from the current snapshot’s `exit_ts` and `now()`:

   - A null 24-hour price is eligible once `now - exit_ts >= 86400000`.
   - A null 48-hour price is eligible once `now - exit_ts >= 172800000`.
   - A populated horizon is never fetched or overwritten.
   - A trade that already has a 24-hour price and then crosses 48 hours fetches only the missing 48-hour value.
   - When several missing horizons on the same trade are eligible, call `fetchPrice` once for that `contract_address` and store that same valid observation on each horizon being filled.
   - A null, invalid, or thrown fetch leaves the eligible fields null. The initial snapshot is still appended so a later run can retry. An existing snapshot is left untouched when the retry fetch fails.

7. The production `fetchPrice` duplicates `fetchTokenPrice()` from `scripts/recordOutcomes.js`, including URL encoding, the silent 15-second curl limit, the 20-second `execFileSync` timeout, conditional bearer authorization, and the response-field order. It then applies the finite-and-positive validation from Shared Constraints.

8. For each horizon that receives a price, set:

   - `counterfactual_hold_pnl_usd = quantity * hold_price - cost_basis_usd`
   - `delta_usd = pnl_usd - counterfactual_hold_pnl_usd`
   - `beat_hold = pnl_usd > counterfactual_hold_pnl_usd`

   Persist `beat_hold_24h` or `beat_hold_48h` and the hold price. Leave counterfactual P&L and delta out of the ledger and derive them again when building a report. Equal P&L produces `false`.

9. Emit one JSON report only when the run appended at least one ledger line. Write it under `reportsDir` as `profit-take-calibration-YYYYMMDD-HHMMSS.json`, using the UTC components of `now()`. If that filename exists, use the first free suffix `-2`, `-3`, and so on. Do not overwrite an existing report file. `report_id` is `profit_take_calibration_` plus the same `YYYYMMDDHHMMSS` digits, and the same `-2` style suffix when one was required.

   The report summarizes the full post-run ledger state, meaning the last valid snapshot for every `trade_id`, not only the lines appended in this run. Its shape is:

    {
      "report_type": "profit_take_calibration",
      "report_id": "profit_take_calibration_YYYYMMDDHHMMSS",
      "generated_at": "ISO8601 from now()",
      "trade_count": 0,
      "with_24h_count": 0,
      "with_48h_count": 0,
      "with_both_count": 0,
      "cohorts": {
        "stop_loss": {
          "trade_count": 0,
          "with_both_count": 0,
          "h24": {
            "evaluated_count": 0,
            "beat_hold_count": 0,
            "beat_hold_rate_pct": null,
            "average_delta_usd": null,
            "median_delta_usd": null
          },
          "h48": {
            "evaluated_count": 0,
            "beat_hold_count": 0,
            "beat_hold_rate_pct": null,
            "average_delta_usd": null,
            "median_delta_usd": null
          }
        },
        "target_hit": {},
        "manual_action": {}
      }
    }

   `target_hit` and `manual_action` use the same object shape as `stop_loss`. Counts are integers. `with_24h_count`, `with_48h_count`, and `with_both_count` count distinct current snapshots with those prices populated. Cohort `trade_count` is the number of current snapshots in that cohort. A horizon’s `evaluated_count` is the number of those snapshots with that hold price populated, and `beat_hold_count` counts snapshots whose corresponding `beat_hold_*` value is `true`. When `evaluated_count` is zero, the rate, average, and median are `null`. Otherwise `beat_hold_rate_pct` is `beat_hold_count / evaluated_count * 100`, and the average and median are computed from that horizon’s `delta_usd` values. Median is the middle value of the ascending numeric sort for an odd count, and the mean of the two middle values for an even count. Do not pre-round the stored numbers.

10. A run that appends no line must leave the ledger bytes unchanged and must not create a report file or an empty report directory.

11. Create hourly install and remove scripts that mirror `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh`.

    - Default schedule: `0 * * * *`.
    - The cron command is `cd $REPO_DIR && $NODE_BIN $REPO_DIR/scripts/profitTakeCalibration.js >> $CRON_LOG 2>&1`.
    - Support idempotent detection, `--dry-run`, `--help`, and installation output. The installer also supports `--print`, which prints the cron line and exits before touching crontab.
    - Environment overrides are `PROFIT_TAKE_CALIBRATION_REPO_DIR`, `PROFIT_TAKE_CALIBRATION_NODE_BIN`, `PROFIT_TAKE_CALIBRATION_CRONTAB_BIN`, `PROFIT_TAKE_CALIBRATION_CRON_LOG`, and `PROFIT_TAKE_CALIBRATION_CRON_SCHEDULE`. The default log path is `logs/profit-take-calibration.log` inside the repository.
    - Detect an existing entry by the calibration script path.
    - Implementation and verification must not install or remove a crontab entry. Verification may run the installer with `--print` only.

12. Add these package scripts:

    - `profit-take:calibration`: `node scripts/profitTakeCalibration.js`
    - `profit-take:calibration:cron:print`: `bash scripts/installProfitTakeCalibrationCron.sh --print`
    - `profit-take:calibration:cron:install`: `bash scripts/installProfitTakeCalibrationCron.sh`
    - `profit-take:calibration:cron:remove`: `bash scripts/removeProfitTakeCalibrationCron.sh`

    Extend `check` by appending syntax checks for the two new JavaScript files, `bash -n` for the two new shell scripts, and execution of `scripts/verifyProfitTakeCalibration.js`. Keep every existing check step.

13. Create `scripts/verifyProfitTakeCalibration.js` using temporary fixtures and injected portfolio, ledger, report, clock, and price-fetcher dependencies. It must assert all of the following:

    - Included reasons are `stop_loss`, `target_1`, `target_2`, `target_3`, `manual_operator`, and `manual_operator_action`.
    - Excluded reasons are `stop`, `STOP_LOSS`, `target_4`, `manual`, `Manual_operator_action`, `stub_flatten`, `fraud_risk_breach`, and `non_tradeable_force_exit`.
    - Initial ingestion maps `reason` to `exit_reason`, `ts` to `exit_ts`, `fill_price` ahead of an invalid `price`, and `cost_portion_usd` when `cost_basis_usd` is absent.
    - A second portfolio row with the same `trade_id`, and a second run, add no further initial snapshot.
    - A trade younger than 24 hours causes no fetch and no second ledger line.
    - An eligible 24-hour row that already has `hold_price_24h` is not fetched again.
    - A row older than 48 hours that already has the 24-hour price receives only 48-hour fields, with the 24-hour price and boolean preserved.
    - A first run older than 48 hours performs one fetch and writes one ledger line containing both prices.
    - A failed fetch leaves null horizon fields and a later successful fetch fills them.
    - `beat_hold` is strict greater-than, and the report’s average, even-count median, odd-count median, and null-empty metrics follow requirement 9.
    - A malformed ledger line between valid lines does not drop those valid lines.
    - A run with no new trade and no newly filled horizon leaves the ledger bytes unchanged and creates no report.
    - The report after a second, later trade includes both trades.
    - Patching file write, append, rename, and truncate operations fails the test if the portfolio path is the target, and the fixture bytes remain unchanged after a full run.
    - The installer `--print` output contains the calibration script path and does not invoke crontab.

### Acceptance Criteria

- The script recognizes only the three specified exit cohorts and reads the closed-trade fields named above.
- The production price request matches `fetchTokenPrice()` and accepts only a finite positive price.
- Ledger history is append-only, each run adds at most one line per trade, and current state is the last snapshot per `trade_id`.
- Horizon observations are independent, retryable, and idempotent.
- Each report’s metrics cover the full current ledger and use realized P&L minus counterfactual hold P&L.
- No implementation or test path writes to `portfolio.json`.
- Cron scripts are printable and idempotent, and tests do not install or remove cron entries.
- No generated ledger or report is committed.
- `npm install && npm run check` succeeds.

## Phase 2 - Report API and Reports-Tab Panel

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=dashboard/app.js -->
<!-- runner:read=server.js -->
<!-- runner:read=dashboard/app.js -->
<!-- runner:read=scripts/profitTakeCalibration.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Extend `server.js` using the existing attribution-report pattern:

   - Add a constant for the runtime `reports/profit-take-calibration` directory.
   - Add a dedicated listing function. Do not introduce a shared report abstraction.
   - Accept only filenames matching `profit-take-calibration-\d{8}-\d{6}(?:-\d+)?\.json`.
   - Parse through `readReportFile()`.
   - Retain only objects whose `report_type` is exactly `profit_take_calibration`.
   - Sort newest first by the `generated_at` string, then by filename descending.
   - A directory read or parse failure returns an empty list.
   - Add a summary function that returns only `report_id`, `generated_at`, `trade_count`, `with_24h_count`, `with_48h_count`, `with_both_count`, and `cohorts`. Each cohort object keeps `trade_count`, `with_both_count`, `h24`, and `h48` as stored. Omit credentials, filesystem paths, and every other field.

2. Add `GET /api/profit-take-calibration/reports`.

   - Return at most the 30 newest summaries as a JSON array through `sendJson`.
   - Return `[]` with HTTP 200 when the directory is absent, unreadable, or contains no valid reports.
   - Follow the existing route and error-handling style.
   - Do not generate reports, read `portfolio.json`, or run the calibration script from the request handler.

3. Extend `dashboard/app.js` with separate Reports-tab state for the new endpoint.

   - Fetch `GET /api/profit-take-calibration/reports` when `page === "reports"`, in the same page-selection effect that calls `loadReports()`.
   - Keep calibration loading and error state independent from `reports`, `reportsError`, and the other dashboard loaders.
   - Display `data[0]` from a successful array response.
   - Do not add a frontend dependency or a navigation page.

4. Add a Profit-Take Calibration section to the Reports tab using the existing card, panel, grid, badge, currency, percentage, loading, error, and empty-state styles.

   - Show `generated_at` and `trade_count`.
   - Show `with_24h_count`, `with_48h_count`, and `with_both_count`.
   - Show one row or compact card for each cohort, labeled “Stop Loss,” “Target Hit,” and “Manual Action,” in that order.
   - For `h24` and `h48`, show `evaluated_count`, `beat_hold_rate_pct`, and `average_delta_usd`.
   - Render a null rate or null delta as an em dash (`—`). Render numeric zero as zero.
   - A positive average delta, a negative average delta, zero, loading, an empty report list, and an API error must each be visible in the section without reading raw JSON.
   - Format rates as percentages and deltas as USD.

5. Limit the phase diff to report discovery, the new GET route, Reports-tab fetching, and the new section. Leave report generation, portfolio state, trading behavior, and existing report panels unchanged.

### Acceptance Criteria

- The endpoint returns newest-first, bounded summaries in the Phase 1 report shape.
- Missing or malformed runtime report data becomes an empty array and the server continues to handle existing routes.
- The Reports tab fetches and renders the latest calibration report from the named fields.
- Every cohort displays 24-hour and 48-hour evaluated count, beat-hold rate, and average USD delta.
- Existing report panels and their loaders continue to work when the calibration request fails.
- No path outside the Phase 2 touch list is modified.
- `npm install && npm run check` succeeds.
```

Raw Response:

```text
I'll review the draft against the repository's existing outcome, cron, server, and dashboard patterns so the verdict is based on whether the spec is implementable as written.---STATUS---
status: revise
reason: Closed trades store reason and ts, and the report contract never defines cumulative metrics, same-run snapshot cardinality, or field names.
```spec
# Profit-Taking Calibration Cohort

## Overview

Add an idempotent calibration workflow that compares deterministic profit-taking exits with the counterfactual result of holding each exited quantity for 24 and 48 hours. A horizon observation is the spot price returned by the existing E3D token-info endpoint at the first successful fetch after that horizon elapses. The workflow reads closed trades from `portfolio.json`, records append-only calibration snapshots at runtime, emits cumulative cohort summaries, exposes recent summaries through the server, and displays the latest results in the Reports tab.

## Goals

- Measure `stop_loss`, `target_1`, `target_2`, `target_3`, and `manual_operator*` exits against 24-hour and 48-hour hold counterfactuals.
- Reuse the E3D `/token-info/<address>` price-fetch mechanism from `scripts/recordOutcomes.js` by duplicating it locally.
- Preserve an append-only, idempotent runtime ledger.
- Produce machine-readable cumulative summaries for `stop_loss`, `target_hit`, and `manual_action`.
- Add an hourly cron integration consistent with the existing record-outcomes scripts.
- Expose recent reports through the local API and dashboard.
- Add deterministic regression coverage for cohort selection, horizon gating, summary math, and portfolio immutability.

## Non-Goals

- Changing stop distances, target multiples, partial-take fractions, or trading decisions.
- Distinguishing initial stops from trailing stops.
- Adding CoinGecko, DexScreener, a historical candle API, or another price source.
- Changing Scout, Harvest, Risk, sizing, execution, or cooldown behavior.
- Writing to `portfolio.json`.
- Migrating existing closed trades or pre-populating generated artifacts in source control.
- Introducing a report-listing framework, database, frontend framework, or external dependency.
- Importing `scripts/recordOutcomes.js`. Loading that module executes its CLI.

## Existing Files

- `scripts/recordOutcomes.js` contains the authenticated E3D token-price fetch. `fetchTokenPrice()` requests `${E3D_API_BASE_URL}/token-info/${encodeURIComponent(address)}` with `execFileSync("curl", ["-s", "--max-time", "15", url, ...optional bearer header], { encoding: "utf8", timeout: 20000 })`. The bearer header is `Authorization: Bearer ${E3D_API_KEY}` and is sent only when `E3D_API_KEY` is non-empty. The base URL defaults to `https://e3d.ai/api`. The accepted response fields, in order, are `priceUSD`, `price_usd`, `current_price`, and `market_data.current_price.usd`.
- Closed sells are appended to `portfolio.closed_trades` by `executeSell()` in `pipeline.js`. The source fields are `trade_id`, `symbol`, `contract_address`, `side` (`sell`), `reason`, `ts`, `quantity`, `price`, `fill_price`, `pnl_usd`, and `cost_portion_usd`. There is no `exit_reason`, `exit_ts`, or `cost_basis_usd` field on those records. `reason` is exactly `stop_loss`, `target_1`, `target_2`, `target_3`, or the operator string, whose default is `manual_operator_action`.
- `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh` define the cron installation conventions, including `--dry-run`, installer `--print`, idempotent detection, and environment overrides.
- `server.js` contains report-directory constants, `readReportFile()`, per-directory listing functions, summary functions, and `GET /api/attribution/reports`.
- `dashboard/app.js` loads the Reports tab through `loadReports()` when `page === "reports"`, with separate loading and error state.
- `package.json` contains the runnable commands and the repository-wide `check` command.
- `portfolio.json` is an input only and must remain byte-for-byte unchanged.

## Shared Constraints

- Keep the implementation within 15 changed files and 1600 changed lines.
- Phase 1 may change only `scripts/profitTakeCalibration.js`, `scripts/verifyProfitTakeCalibration.js`, `scripts/installProfitTakeCalibrationCron.sh`, `scripts/removeProfitTakeCalibrationCron.sh`, and `package.json`. Phase 2 may change only `server.js` and `dashboard/app.js`.
- Runtime execution of the calibration CLI may create `logs/profit-take-calibration.jsonl` and `reports/profit-take-calibration/profit-take-calibration-YYYYMMDD-HHMMSS.json`. Verification must redirect those writes to temporary directories. Do not commit generated ledgers or reports.
- Treat `portfolio.json` as strictly read-only.
- Add no runtime or development dependencies.
- Use ESM and the repository’s existing Node.js style.
- Duplicate the `fetchTokenPrice()` curl invocation locally. Do not import `scripts/recordOutcomes.js`.
- Do not expose API credentials, authorization headers, or response bodies in output, reports, errors, or tests.
- A valid fetched price is a finite number greater than zero after `Number()` coercion of the first present fallback field. Any other result is a failed fetch.
- Use UTC ISO-8601 timestamps from `Date.prototype.toISOString()` and exact millisecond horizons: 24 hours is `86400000` ms and 48 hours is `172800000` ms.
- Preserve unrelated working-tree changes.
- `npm install && npm run check` must pass after every phase.

## Phase 1 - Calibration Ledger, Summary, Scheduling, and Regression Coverage

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/profitTakeCalibration.js -->
<!-- pilot:touches=scripts/verifyProfitTakeCalibration.js -->
<!-- pilot:touches=scripts/installProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=scripts/removeProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/recordOutcomes.js -->
<!-- runner:read=scripts/installRecordOutcomesCron.sh -->
<!-- runner:read=scripts/removeRecordOutcomesCron.sh -->
<!-- runner:read=pipeline.js -->
<!-- runner:read=package.json -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Create `scripts/profitTakeCalibration.js` with exported functions and a direct-execution entry point. Export `classifyExitCohort(reason)` and `runProfitTakeCalibration(options)`. The CLI calls `runProfitTakeCalibration()` with production defaults. `options` accepts `portfolioPath`, `ledgerPath`, `reportsDir`, `now`, `fetchPrice`, and `env`. `now()` returns epoch milliseconds and defaults to `Date.now`. `fetchPrice(address)` returns a finite price or `null` and defaults to the local token-info fetch. Production paths are the repository-root `portfolio.json`, `logs/profit-take-calibration.jsonl`, and `reports/profit-take-calibration/`.

2. Implement case-sensitive cohort classification from the closed trade’s `reason` string:

   - Exactly `stop_loss` maps to `stop_loss`.
   - Exactly `target_1`, `target_2`, or `target_3` maps to `target_hit`.
   - A string whose first characters are `manual_operator` maps to `manual_action`.
   - Every other value, including `stop`, `STOP_LOSS`, `target_4`, `manual`, `stub_flatten`, `fraud_risk_breach`, and `non_tradeable_force_exit`, maps to `null` and is excluded.

3. Read `portfolio.json` only through `portfolioPath`. Parse it once per run. A missing file or invalid top-level JSON makes `runProfitTakeCalibration` throw, and the CLI exits 1. A valid portfolio with no eligible trades is a successful no-op. Process objects in `closed_trades` whose `side` is `sell` or absent. Skip a record, with one concise stderr warning that contains no credential material, when any of the following is true:

   - `classifyExitCohort(reason)` is `null`.
   - Trimmed `trade_id` or trimmed `contract_address` is empty.
   - `ts` does not parse to a finite timestamp.
   - `quantity` is not a finite number greater than zero.
   - `pnl_usd` is not finite.
   - Cost basis is not finite. Use `cost_basis_usd` when it is finite, including zero; otherwise use `cost_portion_usd`.
   - Exit price is not finite and greater than zero. Use `fill_price` when it is valid; otherwise use `price`.

   Skipping a record must not prevent later valid records from being processed. A missing `symbol` becomes an empty string.

4. Represent each calibrated trade with these normalized fields, in this order:

    {
      "trade_id": "string",
      "symbol": "string",
      "contract_address": "string",
      "exit_reason": "string",
      "exit_cohort": "stop_loss|target_hit|manual_action",
      "exit_ts": "ISO8601 from trade.ts",
      "exit_price": 0,
      "quantity": 0,
      "pnl_usd": 0,
      "cost_basis_usd": 0,
      "hold_price_24h": null,
      "hold_price_48h": null,
      "beat_hold_24h": null,
      "beat_hold_48h": null,
      "recorded_at": "ISO8601 from now()"
    }

   `exit_reason` stores the original `reason` string. `exit_cohort` stores the classified cohort.

5. Use `ledgerPath` as an append-only JSONL ledger. Do not rewrite, sort, or truncate it. Create its parent directory only when appending.

   - Load valid JSON objects and select the last valid object for each `trade_id` as its current snapshot.
   - Ignore malformed lines and non-object rows with a stderr warning. Keep every valid row.
   - Portfolio records whose `trade_id` already has a snapshot are not used to change exit fields.
   - For each eligible portfolio trade without a snapshot, build the initial snapshot and fill every horizon that is already eligible in this same run.
   - For an existing snapshot, append a replacement only when at least one horizon moves from `null` to a valid price in this run. Copy all previously populated fields forward.
   - A run appends at most one new line per `trade_id`.
   - `recorded_at` is set from `now()` on the appended line. Snapshot equality ignores `recorded_at`.
   - Duplicate `closed_trades` rows and repeated runs must not create a second initial snapshot for the same `trade_id`.

6. Gate each horizon independently from the current snapshot’s `exit_ts` and `now()`:

   - A null 24-hour price is eligible once `now - exit_ts >= 86400000`.
   - A null 48-hour price is eligible once `now - exit_ts >= 172800000`.
   - A populated horizon is never fetched or overwritten.
   - A trade that already has a 24-hour price and then crosses 48 hours fetches only the missing 48-hour value.
   - When several missing horizons on the same trade are eligible, call `fetchPrice` once for that `contract_address` and store that same valid observation on each horizon being filled.
   - A null, invalid, or thrown fetch leaves the eligible fields null. The initial snapshot is still appended so a later run can retry. An existing snapshot is left untouched when the retry fetch fails.

7. The production `fetchPrice` duplicates `fetchTokenPrice()` from `scripts/recordOutcomes.js`, including URL encoding, the silent 15-second curl limit, the 20-second `execFileSync` timeout, conditional bearer authorization, and the response-field order. It then applies the finite-and-positive validation from Shared Constraints.

8. For each horizon that receives a price, set:

   - `counterfactual_hold_pnl_usd = quantity * hold_price - cost_basis_usd`
   - `delta_usd = pnl_usd - counterfactual_hold_pnl_usd`
   - `beat_hold = pnl_usd > counterfactual_hold_pnl_usd`

   Persist `beat_hold_24h` or `beat_hold_48h` and the hold price. Leave counterfactual P&L and delta out of the ledger and derive them again when building a report. Equal P&L produces `false`.

9. Emit one JSON report only when the run appended at least one ledger line. Write it under `reportsDir` as `profit-take-calibration-YYYYMMDD-HHMMSS.json`, using the UTC components of `now()`. If that filename exists, use the first free suffix `-2`, `-3`, and so on. Do not overwrite an existing report file. `report_id` is `profit_take_calibration_` plus the same `YYYYMMDDHHMMSS` digits, and the same `-2` style suffix when one was required.

   The report summarizes the full post-run ledger state, meaning the last valid snapshot for every `trade_id`, not only the lines appended in this run. Its shape is:

    {
      "report_type": "profit_take_calibration",
      "report_id": "profit_take_calibration_YYYYMMDDHHMMSS",
      "generated_at": "ISO8601 from now()",
      "trade_count": 0,
      "with_24h_count": 0,
      "with_48h_count": 0,
      "with_both_count": 0,
      "cohorts": {
        "stop_loss": {
          "trade_count": 0,
          "with_both_count": 0,
          "h24": {
            "evaluated_count": 0,
            "beat_hold_count": 0,
            "beat_hold_rate_pct": null,
            "average_delta_usd": null,
            "median_delta_usd": null
          },
          "h48": {
            "evaluated_count": 0,
            "beat_hold_count": 0,
            "beat_hold_rate_pct": null,
            "average_delta_usd": null,
            "median_delta_usd": null
          }
        },
        "target_hit": {},
        "manual_action": {}
      }
    }

   `target_hit` and `manual_action` use the same object shape as `stop_loss`. Counts are integers. `with_24h_count`, `with_48h_count`, and `with_both_count` count distinct current snapshots with those prices populated. Cohort `trade_count` is the number of current snapshots in that cohort. A horizon’s `evaluated_count` is the number of those snapshots with that hold price populated, and `beat_hold_count` counts snapshots whose corresponding `beat_hold_*` value is `true`. When `evaluated_count` is zero, the rate, average, and median are `null`. Otherwise `beat_hold_rate_pct` is `beat_hold_count / evaluated_count * 100`, and the average and median are computed from that horizon’s `delta_usd` values. Median is the middle value of the ascending numeric sort for an odd count, and the mean of the two middle values for an even count. Do not pre-round the stored numbers.

10. A run that appends no line must leave the ledger bytes unchanged and must not create a report file or an empty report directory.

11. Create hourly install and remove scripts that mirror `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh`.

    - Default schedule: `0 * * * *`.
    - The cron command is `cd $REPO_DIR && $NODE_BIN $REPO_DIR/scripts/profitTakeCalibration.js >> $CRON_LOG 2>&1`.
    - Support idempotent detection, `--dry-run`, `--help`, and installation output. The installer also supports `--print`, which prints the cron line and exits before touching crontab.
    - Environment overrides are `PROFIT_TAKE_CALIBRATION_REPO_DIR`, `PROFIT_TAKE_CALIBRATION_NODE_BIN`, `PROFIT_TAKE_CALIBRATION_CRONTAB_BIN`, `PROFIT_TAKE_CALIBRATION_CRON_LOG`, and `PROFIT_TAKE_CALIBRATION_CRON_SCHEDULE`. The default log path is `logs/profit-take-calibration.log` inside the repository.
    - Detect an existing entry by the calibration script path.
    - Implementation and verification must not install or remove a crontab entry. Verification may run the installer with `--print` only.

12. Add these package scripts:

    - `profit-take:calibration`: `node scripts/profitTakeCalibration.js`
    - `profit-take:calibration:cron:print`: `bash scripts/installProfitTakeCalibrationCron.sh --print`
    - `profit-take:calibration:cron:install`: `bash scripts/installProfitTakeCalibrationCron.sh`
    - `profit-take:calibration:cron:remove`: `bash scripts/removeProfitTakeCalibrationCron.sh`

    Extend `check` by appending syntax checks for the two new JavaScript files, `bash -n` for the two new shell scripts, and execution of `scripts/verifyProfitTakeCalibration.js`. Keep every existing check step.

13. Create `scripts/verifyProfitTakeCalibration.js` using temporary fixtures and injected portfolio, ledger, report, clock, and price-fetcher dependencies. It must assert all of the following:

    - Included reasons are `stop_loss`, `target_1`, `target_2`, `target_3`, `manual_operator`, and `manual_operator_action`.
    - Excluded reasons are `stop`, `STOP_LOSS`, `target_4`, `manual`, `Manual_operator_action`, `stub_flatten`, `fraud_risk_breach`, and `non_tradeable_force_exit`.
    - Initial ingestion maps `reason` to `exit_reason`, `ts` to `exit_ts`, `fill_price` ahead of an invalid `price`, and `cost_portion_usd` when `cost_basis_usd` is absent.
    - A second portfolio row with the same `trade_id`, and a second run, add no further initial snapshot.
    - A trade younger than 24 hours causes no fetch and no second ledger line.
    - An eligible 24-hour row that already has `hold_price_24h` is not fetched again.
    - A row older than 48 hours that already has the 24-hour price receives only 48-hour fields, with the 24-hour price and boolean preserved.
    - A first run older than 48 hours performs one fetch and writes one ledger line containing both prices.
    - A failed fetch leaves null horizon fields and a later successful fetch fills them.
    - `beat_hold` is strict greater-than, and the report’s average, even-count median, odd-count median, and null-empty metrics follow requirement 9.
    - A malformed ledger line between valid lines does not drop those valid lines.
    - A run with no new trade and no newly filled horizon leaves the ledger bytes unchanged and creates no report.
    - The report after a second, later trade includes both trades.
    - Patching file write, append, rename, and truncate operations fails the test if the portfolio path is the target, and the fixture bytes remain unchanged after a full run.
    - The installer `--print` output contains the calibration script path and does not invoke crontab.

### Acceptance Criteria

- The script recognizes only the three specified exit cohorts and reads the closed-trade fields named above.
- The production price request matches `fetchTokenPrice()` and accepts only a finite positive price.
- Ledger history is append-only, each run adds at most one line per trade, and current state is the last snapshot per `trade_id`.
- Horizon observations are independent, retryable, and idempotent.
- Each report’s metrics cover the full current ledger and use realized P&L minus counterfactual hold P&L.
- No implementation or test path writes to `portfolio.json`.
- Cron scripts are printable and idempotent, and tests do not install or remove cron entries.
- No generated ledger or report is committed.
- `npm install && npm run check` succeeds.

## Phase 2 - Report API and Reports-Tab Panel

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=dashboard/app.js -->
<!-- runner:read=server.js -->
<!-- runner:read=dashboard/app.js -->
<!-- runner:read=scripts/profitTakeCalibration.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Extend `server.js` using the existing attribution-report pattern:

   - Add a constant for the runtime `reports/profit-take-calibration` directory.
   - Add a dedicated listing function. Do not introduce a shared report abstraction.
   - Accept only filenames matching `profit-take-calibration-\d{8}-\d{6}(?:-\d+)?\.json`.
   - Parse through `readReportFile()`.
   - Retain only objects whose `report_type` is exactly `profit_take_calibration`.
   - Sort newest first by the `generated_at` string, then by filename descending.
   - A directory read or parse failure returns an empty list.
   - Add a summary function that returns only `report_id`, `generated_at`, `trade_count`, `with_24h_count`, `with_48h_count`, `with_both_count`, and `cohorts`. Each cohort object keeps `trade_count`, `with_both_count`, `h24`, and `h48` as stored. Omit credentials, filesystem paths, and every other field.

2. Add `GET /api/profit-take-calibration/reports`.

   - Return at most the 30 newest summaries as a JSON array through `sendJson`.
   - Return `[]` with HTTP 200 when the directory is absent, unreadable, or contains no valid reports.
   - Follow the existing route and error-handling style.
   - Do not generate reports, read `portfolio.json`, or run the calibration script from the request handler.

3. Extend `dashboard/app.js` with separate Reports-tab state for the new endpoint.

   - Fetch `GET /api/profit-take-calibration/reports` when `page === "reports"`, in the same page-selection effect that calls `loadReports()`.
   - Keep calibration loading and error state independent from `reports`, `reportsError`, and the other dashboard loaders.
   - Display `data[0]` from a successful array response.
   - Do not add a frontend dependency or a navigation page.

4. Add a Profit-Take Calibration section to the Reports tab using the existing card, panel, grid, badge, currency, percentage, loading, error, and empty-state styles.

   - Show `generated_at` and `trade_count`.
   - Show `with_24h_count`, `with_48h_count`, and `with_both_count`.
   - Show one row or compact card for each cohort, labeled “Stop Loss,” “Target Hit,” and “Manual Action,” in that order.
   - For `h24` and `h48`, show `evaluated_count`, `beat_hold_rate_pct`, and `average_delta_usd`.
   - Render a null rate or null delta as an em dash (`—`). Render numeric zero as zero.
   - A positive average delta, a negative average delta, zero, loading, an empty report list, and an API error must each be visible in the section without reading raw JSON.
   - Format rates as percentages and deltas as USD.

5. Limit the phase diff to report discovery, the new GET route, Reports-tab fetching, and the new section. Leave report generation, portfolio state, trading behavior, and existing report panels unchanged.

### Acceptance Criteria

- The endpoint returns newest-first, bounded summaries in the Phase 1 report shape.
- Missing or malformed runtime report data becomes an empty array and the server continues to handle existing routes.
- The Reports tab fetches and renders the latest calibration report from the named fields.
- Every cohort displays 24-hour and 48-hour evaluated count, beat-hold rate, and average USD delta.
- Existing report panels and their loaders continue to work when the calibration request fails.
- No path outside the Phase 2 touch list is modified.
- `npm install && npm run check` succeeds.
```
```

### Reviewer 2: claude

Status: approved

Reason: Draft is detailed, internally consistent, and testable; phases, constraints, ledger semantics, and acceptance criteria are well specified.

Raw Response:

```text
---STATUS---
status: approved
reason: Draft is detailed, internally consistent, and testable; phases, constraints, ledger semantics, and acceptance criteria are well specified.
```

### Reviewer 3: codex

Status: approved

Reason: The draft is internally consistent, implementation-ready, and provides precise behavioral, testing, scope, and acceptance requirements.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, implementation-ready, and provides precise behavioral, testing, scope, and acceptance requirements.
```

### Reviewer 4: devin

Status: approved

Reason: Spec is internally consistent, all field names reconcile across requirements 4/6/8/9, deduplication and retry semantics are unambiguous, and verification coverage maps 1-to-1 to each behavioral requirement.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, all field names reconcile across requirements 4/6/8/9, deduplication and retry semantics are unambiguous, and verification coverage maps 1-to-1 to each behavioral requirement.
```

### Reviewer 5: local

Status: approved

Reason: (no reason provided by reviewer)

Raw Response:

```text
---STATUS---
status: approved
```

Round Result: not converged

At least one reviewer requested revision in round 1.

## Round 2

### Draft Before Round

```text
# Profit-Taking Calibration Cohort

## Overview

Add an idempotent calibration workflow that compares deterministic profit-taking exits with the counterfactual result of holding each exited quantity for 24 and 48 hours. A horizon observation is the spot price returned by the existing E3D token-info endpoint at the first successful fetch after that horizon elapses. The workflow reads closed trades from `portfolio.json`, records append-only calibration snapshots at runtime, emits cumulative cohort summaries, exposes recent summaries through the server, and displays the latest results in the Reports tab.

## Goals

- Measure `stop_loss`, `target_1`, `target_2`, `target_3`, and `manual_operator*` exits against 24-hour and 48-hour hold counterfactuals.
- Reuse the E3D `/token-info/<address>` price-fetch mechanism from `scripts/recordOutcomes.js` by duplicating it locally.
- Preserve an append-only, idempotent runtime ledger.
- Produce machine-readable cumulative summaries for `stop_loss`, `target_hit`, and `manual_action`.
- Add an hourly cron integration consistent with the existing record-outcomes scripts.
- Expose recent reports through the local API and dashboard.
- Add deterministic regression coverage for cohort selection, horizon gating, summary math, and portfolio immutability.

## Non-Goals

- Changing stop distances, target multiples, partial-take fractions, or trading decisions.
- Distinguishing initial stops from trailing stops.
- Adding CoinGecko, DexScreener, a historical candle API, or another price source.
- Changing Scout, Harvest, Risk, sizing, execution, or cooldown behavior.
- Writing to `portfolio.json`.
- Migrating existing closed trades or pre-populating generated artifacts in source control.
- Introducing a report-listing framework, database, frontend framework, or external dependency.
- Importing `scripts/recordOutcomes.js`. Loading that module executes its CLI.

## Existing Files

- `scripts/recordOutcomes.js` contains the authenticated E3D token-price fetch. `fetchTokenPrice()` requests `${E3D_API_BASE_URL}/token-info/${encodeURIComponent(address)}` with `execFileSync("curl", ["-s", "--max-time", "15", url, ...optional bearer header], { encoding: "utf8", timeout: 20000 })`. The bearer header is `Authorization: Bearer ${E3D_API_KEY}` and is sent only when `E3D_API_KEY` is non-empty. The base URL defaults to `https://e3d.ai/api`. The accepted response fields, in order, are `priceUSD`, `price_usd`, `current_price`, and `market_data.current_price.usd`.
- Closed sells are appended to `portfolio.closed_trades` by `executeSell()` in `pipeline.js`. The source fields are `trade_id`, `symbol`, `contract_address`, `side` (`sell`), `reason`, `ts`, `quantity`, `price`, `fill_price`, `pnl_usd`, and `cost_portion_usd`. There is no `exit_reason`, `exit_ts`, or `cost_basis_usd` field on those records. `reason` is exactly `stop_loss`, `target_1`, `target_2`, `target_3`, or the operator string, whose default is `manual_operator_action`.
- `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh` define the cron installation conventions, including `--dry-run`, installer `--print`, idempotent detection, and environment overrides.
- `server.js` contains report-directory constants, `readReportFile()`, per-directory listing functions, summary functions, and `GET /api/attribution/reports`.
- `dashboard/app.js` loads the Reports tab through `loadReports()` when `page === "reports"`, with separate loading and error state.
- `package.json` contains the runnable commands and the repository-wide `check` command.
- `portfolio.json` is an input only and must remain byte-for-byte unchanged.

## Shared Constraints

- Keep the implementation within 15 changed files and 1600 changed lines.
- Phase 1 may change only `scripts/profitTakeCalibration.js`, `scripts/verifyProfitTakeCalibration.js`, `scripts/installProfitTakeCalibrationCron.sh`, `scripts/removeProfitTakeCalibrationCron.sh`, and `package.json`. Phase 2 may change only `server.js` and `dashboard/app.js`.
- Runtime execution of the calibration CLI may create `logs/profit-take-calibration.jsonl` and `reports/profit-take-calibration/profit-take-calibration-YYYYMMDD-HHMMSS.json`. Verification must redirect those writes to temporary directories. Do not commit generated ledgers or reports.
- Treat `portfolio.json` as strictly read-only.
- Add no runtime or development dependencies.
- Use ESM and the repository’s existing Node.js style.
- Duplicate the `fetchTokenPrice()` curl invocation locally. Do not import `scripts/recordOutcomes.js`.
- Do not expose API credentials, authorization headers, or response bodies in output, reports, errors, or tests.
- A valid fetched price is a finite number greater than zero after `Number()` coercion of the first present fallback field. Any other result is a failed fetch.
- Use UTC ISO-8601 timestamps from `Date.prototype.toISOString()` and exact millisecond horizons: 24 hours is `86400000` ms and 48 hours is `172800000` ms.
- Preserve unrelated working-tree changes.
- `npm install && npm run check` must pass after every phase.

## Phase 1 - Calibration Ledger, Summary, Scheduling, and Regression Coverage

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/profitTakeCalibration.js -->
<!-- pilot:touches=scripts/verifyProfitTakeCalibration.js -->
<!-- pilot:touches=scripts/installProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=scripts/removeProfitTakeCalibrationCron.sh -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/recordOutcomes.js -->
<!-- runner:read=scripts/installRecordOutcomesCron.sh -->
<!-- runner:read=scripts/removeRecordOutcomesCron.sh -->
<!-- runner:read=pipeline.js -->
<!-- runner:read=package.json -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Create `scripts/profitTakeCalibration.js` with exported functions and a direct-execution entry point. Export `classifyExitCohort(reason)` and `runProfitTakeCalibration(options)`. The CLI calls `runProfitTakeCalibration()` with production defaults. `options` accepts `portfolioPath`, `ledgerPath`, `reportsDir`, `now`, `fetchPrice`, and `env`. `now()` returns epoch milliseconds and defaults to `Date.now`. `fetchPrice(address)` returns a finite price or `null` and defaults to the local token-info fetch. Production paths are the repository-root `portfolio.json`, `logs/profit-take-calibration.jsonl`, and `reports/profit-take-calibration/`.

2. Implement case-sensitive cohort classification from the closed trade’s `reason` string:

   - Exactly `stop_loss` maps to `stop_loss`.
   - Exactly `target_1`, `target_2`, or `target_3` maps to `target_hit`.
   - A string whose first characters are `manual_operator` maps to `manual_action`.
   - Every other value, including `stop`, `STOP_LOSS`, `target_4`, `manual`, `stub_flatten`, `fraud_risk_breach`, and `non_tradeable_force_exit`, maps to `null` and is excluded.

3. Read `portfolio.json` only through `portfolioPath`. Parse it once per run. A missing file or invalid top-level JSON makes `runProfitTakeCalibration` throw, and the CLI exits 1. A valid portfolio with no eligible trades is a successful no-op. Process objects in `closed_trades` whose `side` is `sell` or absent. Skip a record, with one concise stderr warning that contains no credential material, when any of the following is true:

   - `classifyExitCohort(reason)` is `null`.
   - Trimmed `trade_id` or trimmed `contract_address` is empty.
   - `ts` does not parse to a finite timestamp.
   - `quantity` is not a finite number greater than zero.
   - `pnl_usd` is not finite.
   - Cost basis is not finite. Use `cost_basis_usd` when it is finite, including zero; otherwise use `cost_portion_usd`.
   - Exit price is not finite and greater than zero. Use `fill_price` when it is valid; otherwise use `price`.

   Skipping a record must not prevent later valid records from being processed. A missing `symbol` becomes an empty string.

4. Represent each calibrated trade with these normalized fields, in this order:

    {
      "trade_id": "string",
      "symbol": "string",
      "contract_address": "string",
      "exit_reason": "string",
      "exit_cohort": "stop_loss|target_hit|manual_action",
      "exit_ts": "ISO8601 from trade.ts",
      "exit_price": 0,
      "quantity": 0,
      "pnl_usd": 0,
      "cost_basis_usd": 0,
      "hold_price_24h": null,
      "hold_price_48h": null,
      "beat_hold_24h": null,
      "beat_hold_48h": null,
      "recorded_at": "ISO8601 from now()"
    }

   `exit_reason` stores the original `reason` string. `exit_cohort` stores the classified cohort.

5. Use `ledgerPath` as an append-only JSONL ledger. Do not rewrite, sort, or truncate it. Create its parent directory only when appending.

   - Load valid JSON objects and select the last valid object for each `trade_id` as its current snapshot.
   - Ignore malformed lines and non-object rows with a stderr warning. Keep every valid row.
   - Portfolio records whose `trade_id` already has a snapshot are not used to change exit fields.
   - For each eligible portfolio trade without a snapshot, build the initial snapshot and fill every horizon that is already eligible in this same run.
   - For an existing snapshot, append a replacement only when at least one horizon moves from `null` to a valid price in this run. Copy all previously populated fields forward.
   - A run appends at most one new line per `trade_id`.
   - `recorded_at` is set from `now()` on the appended line. Snapshot equality ignores `recorded_at`.
   - Duplicate `closed_trades` rows and repeated runs must not create a second initial snapshot for the same `trade_id`.

6. Gate each horizon independently from the current snapshot’s `exit_ts` and `now()`:

   - A null 24-hour price is eligible once `now - exit_ts >= 86400000`.
   - A null 48-hour price is eligible once `now - exit_ts >= 172800000`.
   - A populated horizon is never fetched or overwritten.
   - A trade that already has a 24-hour price and then crosses 48 hours fetches only the missing 48-hour value.
   - When several missing horizons on the same trade are eligible, call `fetchPrice` once for that `contract_address` and store that same valid observation on each horizon being filled.
   - A null, invalid, or thrown fetch leaves the eligible fields null. The initial snapshot is still appended so a later run can retry. An existing snapshot is left untouched when the retry fetch fails.

7. The production `fetchPrice` duplicates `fetchTokenPrice()` from `scripts/recordOutcomes.js`, including URL encoding, the silent 15-second curl limit, the 20-second `execFileSync` timeout, conditional bearer authorization, and the response-field order. It then applies the finite-and-positive validation from Shared Constraints.

8. For each horizon that receives a price, set:

   - `counterfactual_hold_pnl_usd = quantity * hold_price - cost_basis_usd`
   - `delta_usd = pnl_usd - counterfactual_hold_pnl_usd`
   - `beat_hold = pnl_usd > counterfactual_hold_pnl_usd`

   Persist `beat_hold_24h` or `beat_hold_48h` and the hold price. Leave counterfactual P&L and delta out of the ledger and derive them again when building a report. Equal P&L produces `false`.

9. Emit one JSON report only when the run appended at least one ledger line. Write it under `reportsDir` as `profit-take-calibration-YYYYMMDD-HHMMSS.json`, using the UTC components of `now()`. If that filename exists, use the first free suffix `-2`, `-3`, and so on. Do not overwrite an existing report file. `report_id` is `profit_take_calibration_` plus the same `YYYYMMDDHHMMSS` digits, and the same `-2` style suffix when one was required.

   The report summarizes the full post-run ledger state, meaning the last valid snapshot for every `trade_id`, not only the lines appended in this run. Its shape is:

    {
      "report_type": "profit_take_calibration",
      "report_id": "profit_take_calibration_YYYYMMDDHHMMSS",
      "generated_at": "ISO8601 from now()",
      "trade_count": 0,
      "with_24h_count": 0,
      "with_48h_count": 0,
      "with_both_count": 0,
      "cohorts": {
        "stop_loss": {
          "trade_count": 0,
          "with_both_count": 0,
          "h24": {
            "evaluated_count": 0,
            "beat_hold_count": 0,
            "beat_hold_rate_pct": null,
            "average_delta_usd": null,
            "median_delta_usd": null
          },
          "h48": {
            "evaluated_count": 0,
            "beat_hold_count": 0,
            "beat_hold_rate_pct": null,
            "average_delta_usd": null,
            "median_delta_usd": null
          }
        },
        "target_hit": {},
        "manual_action": {}
      }
    }

   `target_hit` and `manual_action` use the same object shape as `stop_loss`. Counts are integers. `with_24h_count`, `with_48h_count`, and `with_both_count` count distinct current snapshots with those prices populated. Cohort `trade_count` is the number of current snapshots in that cohort. A horizon’s `evaluated_count` is the number of those snapshots with that hold price populated, and `beat_hold_count` counts snapshots whose corresponding `beat_hold_*` value is `true`. When `evaluated_count` is zero, the rate, average, and median are `null`. Otherwise `beat_hold_rate_pct` is `beat_hold_count / evaluated_count * 100`, and the average and median are computed from that horizon’s `delta_usd` values. Median is the middle value of the ascending numeric sort for an odd count, and the mean of the two middle values for an even count. Do not pre-round the stored numbers.

10. A run that appends no line must leave the ledger bytes unchanged and must not create a report file or an empty report directory.

11. Create hourly install and remove scripts that mirror `scripts/installRecordOutcomesCron.sh` and `scripts/removeRecordOutcomesCron.sh`.

    - Default schedule: `0 * * * *`.
    - The cron command is `cd $REPO_DIR && $NODE_BIN $REPO_DIR/scripts/profitTakeCalibration.js >> $CRON_LOG 2>&1`.
    - Support idempotent detection, `--dry-run`, `--help`, and installation output. The installer also supports `--print`, which prints the cron line and exits before touching crontab.
    - Environment overrides are `PROFIT_TAKE_CALIBRATION_REPO_DIR`, `PROFIT_TAKE_CALIBRATION_NODE_BIN`, `PROFIT_TAKE_CALIBRATION_CRONTAB_BIN`, `PROFIT_TAKE_CALIBRATION_CRON_LOG`, and `PROFIT_TAKE_CALIBRATION_CRON_SCHEDULE`. The default log path is `logs/profit-take-calibration.log` inside the repository.
    - Detect an existing entry by the calibration script path.
    - Implementation and verification must not install or remove a crontab entry. Verification may run the installer with `--print` only.

12. Add these package scripts:

    - `profit-take:calibration`: `node scripts/profitTakeCalibration.js`
    - `profit-take:calibration:cron:print`: `bash scripts/installProfitTakeCalibrationCron.sh --print`
    - `profit-take:calibration:cron:install`: `bash scripts/installProfitTakeCalibrationCron.sh`
    - `profit-take:calibration:cron:remove`: `bash scripts/removeProfitTakeCalibrationCron.sh`

    Extend `check` by appending syntax checks for the two new JavaScript files, `bash -n` for the two new shell scripts, and execution of `scripts/verifyProfitTakeCalibration.js`. Keep every existing check step.

13. Create `scripts/verifyProfitTakeCalibration.js` using temporary fixtures and injected portfolio, ledger, report, clock, and price-fetcher dependencies. It must assert all of the following:

    - Included reasons are `stop_loss`, `target_1`, `target_2`, `target_3`, `manual_operator`, and `manual_operator_action`.
    - Excluded reasons are `stop`, `STOP_LOSS`, `target_4`, `manual`, `Manual_operator_action`, `stub_flatten`, `fraud_risk_breach`, and `non_tradeable_force_exit`.
    - Initial ingestion maps `reason` to `exit_reason`, `ts` to `exit_ts`, `fill_price` ahead of an invalid `price`, and `cost_portion_usd` when `cost_basis_usd` is absent.
    - A second portfolio row with the same `trade_id`, and a second run, add no further initial snapshot.
    - A trade younger than 24 hours causes no fetch and no second ledger line.
    - An eligible 24-hour row that already has `hold_price_24h` is not fetched again.
    - A row older than 48 hours that already has the 24-hour price receives only 48-hour fields, with the 24-hour price and boolean preserved.
    - A first run older than 48 hours performs one fetch and writes one ledger line containing both prices.
    - A failed fetch leaves null horizon fields and a later successful fetch fills them.
    - `beat_hold` is strict greater-than, and the report’s average, even-count median, odd-count median, and null-empty metrics follow requirement 9.
    - A malformed ledger line between valid lines does not drop those valid lines.
    - A run with no new trade and no newly filled horizon leaves the ledger bytes unchanged and creates no report.
    - The report after a second, later trade includes both trades.
    - Patching file write, append, rename, and truncate operations fails the test if the portfolio path is the target, and the fixture bytes remain unchanged after a full run.
    - The installer `--print` output contains the calibration script path and does not invoke crontab.

### Acceptance Criteria

- The script recognizes only the three specified exit cohorts and reads the closed-trade fields named above.
- The production price request matches `fetchTokenPrice()` and accepts only a finite positive price.
- Ledger history is append-only, each run adds at most one line per trade, and current state is the last snapshot per `trade_id`.
- Horizon observations are independent, retryable, and idempotent.
- Each report’s metrics cover the full current ledger and use realized P&L minus counterfactual hold P&L.
- No implementation or test path writes to `portfolio.json`.
- Cron scripts are printable and idempotent, and tests do not install or remove cron entries.
- No generated ledger or report is committed.
- `npm install && npm run check` succeeds.

## Phase 2 - Report API and Reports-Tab Panel

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=dashboard/app.js -->
<!-- runner:read=server.js -->
<!-- runner:read=dashboard/app.js -->
<!-- runner:read=scripts/profitTakeCalibration.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Extend `server.js` using the existing attribution-report pattern:

   - Add a constant for the runtime `reports/profit-take-calibration` directory.
   - Add a dedicated listing function. Do not introduce a shared report abstraction.
   - Accept only filenames matching `profit-take-calibration-\d{8}-\d{6}(?:-\d+)?\.json`.
   - Parse through `readReportFile()`.
   - Retain only objects whose `report_type` is exactly `profit_take_calibration`.
   - Sort newest first by the `generated_at` string, then by filename descending.
   - A directory read or parse failure returns an empty list.
   - Add a summary function that returns only `report_id`, `generated_at`, `trade_count`, `with_24h_count`, `with_48h_count`, `with_both_count`, and `cohorts`. Each cohort object keeps `trade_count`, `with_both_count`, `h24`, and `h48` as stored. Omit credentials, filesystem paths, and every other field.

2. Add `GET /api/profit-take-calibration/reports`.

   - Return at most the 30 newest summaries as a JSON array through `sendJson`.
   - Return `[]` with HTTP 200 when the directory is absent, unreadable, or contains no valid reports.
   - Follow the existing route and error-handling style.
   - Do not generate reports, read `portfolio.json`, or run the calibration script from the request handler.

3. Extend `dashboard/app.js` with separate Reports-tab state for the new endpoint.

   - Fetch `GET /api/profit-take-calibration/reports` when `page === "reports"`, in the same page-selection effect that calls `loadReports()`.
   - Keep calibration loading and error state independent from `reports`, `reportsError`, and the other dashboard loaders.
   - Display `data[0]` from a successful array response.
   - Do not add a frontend dependency or a navigation page.

4. Add a Profit-Take Calibration section to the Reports tab using the existing card, panel, grid, badge, currency, percentage, loading, error, and empty-state styles.

   - Show `generated_at` and `trade_count`.
   - Show `with_24h_count`, `with_48h_count`, and `with_both_count`.
   - Show one row or compact card for each cohort, labeled “Stop Loss,” “Target Hit,” and “Manual Action,” in that order.
   - For `h24` and `h48`, show `evaluated_count`, `beat_hold_rate_pct`, and `average_delta_usd`.
   - Render a null rate or null delta as an em dash (`—`). Render numeric zero as zero.
   - A positive average delta, a negative average delta, zero, loading, an empty report list, and an API error must each be visible in the section without reading raw JSON.
   - Format rates as percentages and deltas as USD.

5. Limit the phase diff to report discovery, the new GET route, Reports-tab fetching, and the new section. Leave report generation, portfolio state, trading behavior, and existing report panels unchanged.

### Acceptance Criteria

- The endpoint returns newest-first, bounded summaries in the Phase 1 report shape.
- Missing or malformed runtime report data becomes an empty array and the server continues to handle existing routes.
- The Reports tab fetches and renders the latest calibration report from the named fields.
- Every cohort displays 24-hour and 48-hour evaluated count, beat-hold rate, and average USD delta.
- Existing report panels and their loaders continue to work when the calibration request fails.
- No path outside the Phase 2 touch list is modified.
- `npm install && npm run check` succeeds.

```

### Reviewer 1: grok-build

Status: approved

Reason: The cohort rules, append-only horizon ledger, cumulative summary math, cron contract, and Reports-tab API are internally consistent and match the cited portfolio, token-info, and dashboard patterns.

Raw Response:

```text
I'll review the draft against the repository files it cites so the verdict is based on whether the spec can be implemented as written.---STATUS---
status: approved
reason: The cohort rules, append-only horizon ledger, cumulative summary math, cron contract, and Reports-tab API are internally consistent and match the cited portfolio, token-info, and dashboard patterns.
```

### Reviewer 2: claude

Status: approved

Reason: The spec is internally consistent and testable. Phase scopes, ledger semantics, horizon gating, report math, the portfolio read-only guarantee and the API/dashboard requirements are all defined unambiguously.

Raw Response:

```text
---STATUS---
status: approved
reason: The spec is internally consistent and testable. Phase scopes, ledger semantics, horizon gating, report math, the portfolio read-only guarantee and the API/dashboard requirements are all defined unambiguously.
```

### Reviewer 3: codex

Status: approved

Reason: The draft is internally consistent, implementation-ready, and defines clear behavior, boundaries, verification, and acceptance criteria for both phases.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, implementation-ready, and defines clear behavior, boundaries, verification, and acceptance criteria for both phases.
```

### Reviewer 4: devin

Status: approved

Reason: Spec is internally consistent, all field names and derivations align, idempotency and immutability constraints are unambiguous, and regression coverage addresses every stated behavioral contract.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, all field names and derivations align, idempotency and immutability constraints are unambiguous, and regression coverage addresses every stated behavioral contract.
```

### Reviewer 5: local

Status: approved

Reason: (no reason provided by reviewer)

Raw Response:

```text
---STATUS---
status: approved
```

## Final Outcome

Converged in round 2.
