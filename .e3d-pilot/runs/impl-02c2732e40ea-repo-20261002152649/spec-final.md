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
