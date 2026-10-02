# Phase 2 Summary

- Phase: 2
- Title: Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-10-02T06:42:48-0700
- Exit status: 0

## Implementation Handoff

- Phase implemented: Phase 2 - Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap.
- Updated `pipeline.js` settings defaults with `flow_only_max_position_pct: 0.015` beside `max_position_pct`.
- Added a narrow canonical-warning helper that recognizes `flow_only_candidate` only from `evidence_warnings` and `evidence_summary.warnings`.
- Changed `extractEvidenceMetadata()` to merge warnings/blockers from both top-level evidence metadata and compact summaries so canonical warnings are preserved through existing metadata copy paths.
- Changed `filterScoutCandidatesForDesk()` so the `flow_only_disabled` branch now exempts canonically warned proposals while still dropping non-canonical flow-only-labeled candidates with the same logged reason.
- Exported `filterScoutCandidatesForDesk` for direct regression coverage.
- Changed `evaluateBuyActions()` so only brand-new positions carrying the canonical `flow_only_candidate` warning are capped at `equity * flow_only_max_position_pct`.
- Kept existing add sizing, cash limits, `max_position_pct`, category headroom, minimum trade rejection, and other constraints intact; the smallest applicable cap still wins.
- Extended `scripts/verifyScoutRelaxation.js` to cover:
- desk survival for canonical flow-only proposals using summary-only warning metadata,
- continued desk rejection plus `flow_only_disabled` logging for non-canonical flow-only labels,
- exact 1.5% capping for oversized flow-only new entries,
- unchanged sizing for under-cap flow-only new entries and non-flow-only new entries,
- existing-position add behavior remaining governed by add headroom instead of the new-entry flow-only cap,
- canonical summary warning propagation into buy evaluation,
- other caps still producing allocations below the flow-only ceiling.
- Tests run: `node --check pipeline.js`, `node --check scripts/verifyScoutRelaxation.js`, `node scripts/verifyScoutRelaxation.js`, `npm install`, `npm run check`.
- Verification result: passed.
- Unresolved follow-ups: none for this phase; later phases were intentionally not implemented.

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
