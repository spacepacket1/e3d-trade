# Phase 1 Summary

- Phase: 1
- Title: Calibration Ledger, Summary, Scheduling, and Regression Coverage
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-10-02T08:42:01-0700
- Exit status: 0

## Implementation Handoff

- Phase implemented: Calibration Ledger, Summary, Scheduling, and Regression Coverage.
- Added `scripts/profitTakeCalibration.js` with exported `classifyExitCohort(reason)` and `runProfitTakeCalibration(options)`, production defaults, CLI entrypoint, local E3D token-info price fetch duplication, append-only JSONL ledger handling, independent 24h/48h horizon filling, and cumulative report generation.
- Cohort mapping is case-sensitive and limited to `stop_loss`, `target_1|2|3`, and `manual_operator*`; unsupported reasons are skipped with concise stderr warnings.
- New snapshots normalize sell-side closed trades from `portfolio.json`, preserve field order, never write to the portfolio file, and avoid duplicate initial snapshots across duplicate rows and reruns.
- Existing ledger snapshots now load as last-valid-per-`trade_id`; malformed or non-object ledger rows are ignored with warnings, while valid history remains intact.
- Reports summarize the full post-run current ledger state, compute beat-hold counts/rates plus average and median deltas without rounding, and only write when at least one ledger line was appended.
- Added hourly cron helpers `scripts/installProfitTakeCalibrationCron.sh` and `scripts/removeProfitTakeCalibrationCron.sh` with `--help`, `--dry-run`, install/remove idempotency, env overrides, and installer `--print` support without touching crontab.
- Updated `package.json` with calibration run/cron scripts and extended `check` with syntax checks, shell validation, and `scripts/verifyProfitTakeCalibration.js`.
- Added `scripts/verifyProfitTakeCalibration.js` coverage for cohort inclusion/exclusion, normalization rules, duplicate suppression, horizon gating, failed-fetch retry behavior, strict beat-hold semantics, malformed ledger tolerance, no-op runs, full-state reports, cron `--print`, and portfolio immutability guards.
- Tests run: `node --check scripts/profitTakeCalibration.js`, `node --check scripts/verifyProfitTakeCalibration.js`, `bash -n scripts/installProfitTakeCalibrationCron.sh`, `bash -n scripts/removeProfitTakeCalibrationCron.sh`, `node scripts/verifyProfitTakeCalibration.js`, `npm install`, `npm run check`.
- Decisions: kept the implementation scoped to Phase 1 files only; report/ledger directories are created only on append paths; no crontab install/remove was performed during verification.
- Unresolved follow-ups: none in Phase 1 scope.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .codex-spec-runner/summaries/phase-1.md`
- ` M package.json`
- `?? scripts/installProfitTakeCalibrationCron.sh`
- `?? scripts/profitTakeCalibration.js`
- `?? scripts/removeProfitTakeCalibrationCron.sh`
- `?? scripts/verifyProfitTakeCalibration.js`
