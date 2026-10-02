# Phase 2 Summary

- Phase: 2
- Title: Enable Cooldown-Guarded Pyramid-In
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-10-01T11:09:45-0700
- Exit status: 0

## Implementation Handoff

- Scope: Implemented cooldown-guarded pyramid-in only; left later phases and unrelated trade behavior unchanged.
- `pipeline.js`: Added shared case-insensitive symbol/cooldown helpers and exported the requested scout/buy/ranking seams for regression coverage.
- `openPosition()`: Existing positions now resolve by case-insensitive key, reject active add cooldowns before any cash/history writes, preserve one stored key, recompute quantity/cost-basis/average entry, never loosen stops, merge targets per partial-taken status, and write a normalized 24-hour `pyramid_add` cooldown only after a successful add.
- `buildScoutEvidenceShortlist()`: Stopped excluding held names from shortlist admission, still honors real disqualifiers/avoid lists, and now removes cooling held symbols before packet creation.
- `runScoutDirect()` and `buildCognitiveState()`: Held addresses no longer seed disqualifiers; held names are skipped only when their symbol is actively cooling down.
- Scout prompts: Updated direct/tool/prompt instructions so held symbols may be proposed only as fresh, evidence-backed adds outside the 24-hour add cooldown; disqualifier exclusions remain mandatory.
- `filterScoutCandidatesAgainstPortfolio()`: Keeps held candidates unless their symbol is in an active cooldown; keeps unheld candidates here even if another path later rejects them.
- `rankApprovedCandidates()`: Removed the unconditional held-position drop, retained case-insensitive cooldown filtering, and kept downstream ordering/deterministic checks intact.
- `evaluateRotationActions()`: Still cannot rotate into an already-held symbol; the held-symbol exclusion now happens after ranking rather than inside the ranking function.
- `evaluateBuyActions()`: New-entry caps no longer short-circuit the whole function; adds can still emit when the book/thesis cap is full, consume a buy slot only, and use reason `pyramid_add`.
- `scripts/verifyScoutRelaxation.js`: Added deterministic regression coverage for case-insensitive adds, stop/target preservation, 24-hour add cooldown creation and blocking, held-symbol scout admission/filtering/ranking, rotation self-exclusion, add-vs-new-entry buy behavior under full caps, and non-add paths that must not create cooldowns.
- Tests run: `node --check pipeline.js`, `node --check scripts/verifyScoutRelaxation.js`, `node scripts/verifyScoutRelaxation.js`, `npm install`, `npm run check`.
- Verification result: All passed. `npm run check` still prints the existing offline warning noise from map/ClickHouse-related checks, but exits successfully.
- Unresolved follow-up: None identified within Phase 2 scope.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .codex-spec-runner/summaries/phase-1.md`
- ` M .codex-spec-runner/summaries/phase-2.md`
- ` M pipeline.js`
- ` M scripts/evidencePackets.js`
- ` M scripts/verifyEvidencePackets.js`
- ` M scripts/verifyScoutRelaxation.js`
