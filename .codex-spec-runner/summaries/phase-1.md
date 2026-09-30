# Phase 1 Summary

- Phase: 1
- Title: Sidecar Evidence Storage and Compatibility Resolver
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-09-30T14:48:21-0700
- Exit status: 0

## Implementation Handoff

- Added `scripts/tradeEvidence.js` with synchronous `resolveTradeEvidence` and `externalizeTradeEvidence`.
- Resolver supports embedded historical evidence first, sidecar lookup by `evidence_ref`, last-valid-match wins, and tolerant handling for missing/unreadable/malformed sidecars.
- Externalizer validates and serializes before file or object mutation, appends one JSONL record with all four keys, fsyncs before mutating the trade, preserves the input on append/fsync failure, and no-ops for already externalized trades.
- Default sidecar path is repository-root `logs/trade-evidence.jsonl`; default append inserts one separator newline when a pre-existing file ends with a partial unterminated fragment.
- Updated `pipeline.js` to import the shared module, re-export `resolveTradeEvidence` by reference, and externalize only on the Phase 1 live persistence paths:
- Manual sells in `applyPendingManualActions`
- Hard sells in the run-cycle sell loop
- Harvest sells after post-return lifecycle attachment
- Rotation sells after `executeSell` and rotation buys after post-return lifecycle attachment
- Paper buys after post-return lifecycle attachment
- Trend-sleeve buys and sells inside `executeTrendSleeve`
- Kept `openPosition`, `executeSell`, `recordTradeEvent`, `recordOutcomeEvent`, `savePortfolio`, and loaded historical portfolio scans free of externalization so training-event snapshots still embed evidence as before.
- Added `scripts/verifyTradeEvidence.js` covering embedded history, embedded-over-sidecar precedence, `evidence_ref` resolution, JSON-null serialization for missing evidence, validation/serialization-before-mutation, append-before-fsync ordering, invalid/unserializable inputs, append/fsync failure preservation, idempotent re-externalization, malformed/missing/unreadable sidecars, duplicate IDs, partial trailing fragments, nullish/non-object trades, and the `pipeline.js` re-export identity check.
- Updated `package.json` to add syntax/runtime checks for the new trade-evidence scripts into the existing `npm run check` chain without replacing the configured suite.
- Tests run: `node --check scripts/tradeEvidence.js`, `node --check scripts/verifyTradeEvidence.js`, `node --check pipeline.js`, `node scripts/verifyTradeEvidence.js`, `npm install`, `npm run check`.
- Decisions: externalization stays scoped to live newly created trade objects only; each of the six call sites catches a sidecar externalization failure locally (log and continue), so the trade still saves normally, embedded rather than sidecar-backed, and nothing about that trade's own success/failure/retry outcome is affected by the externalization failure.
- Unresolved follow-ups: Phase 2 consumer migrations are intentionally not implemented here.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .codex-spec-runner/summaries/phase-1.md`
- ` M package.json`
- ` M pipeline.js`
- `?? scripts/tradeEvidence.js`
- `?? scripts/verifyTradeEvidence.js`
