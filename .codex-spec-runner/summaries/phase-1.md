# Phase 1 Summary

- Phase: 1
- Title: Close the Late-Signal Self-Evidencing Loophole
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-10-01T11:07:24-0700
- Exit status: 0

## Implementation Handoff

- Phase implemented: Close the Late-Signal Self-Evidencing Loophole.
- Updated `scripts/evidencePackets.js` to export `LATE_SIGNAL_STORY_TYPES` as the canonical `Set(["MOVER", "SURGE"])`.
- Added shared helper `countGenuineStoryEvidence(evidence)` and used it only on normalized evidence items.
- Genuine Scout story-side support now counts `thesis`, `watchlist`, and `story` items whose normalized non-blank `story_type` is not `MOVER` or `SURGE`.
- Legacy `story` items with missing/blank `story_type` remain genuine; no label-based `story_type` inference was added.
- Normalized `story` items now preserve authored non-blank `story_type` as trimmed uppercase; non-story items never retain stray `story_type`.
- `story_type` now participates in evidence dedupe identity, evidence ids, and packet digests only when present and non-blank, preserving legacy ids for untyped stories.
- `scoreEvidencePacket()` now sets `story_evidence_count` from the shared helper, so warnings, missing-evidence behavior, and the quality term all use the same genuine count.
- `evaluateScoutPacketEligibility()` now recomputes genuine story evidence from `packet.evidence` and ignores any prefilled `packet.story_evidence_count` for `flow_only` and missing-story decisions.
- `pipeline.js` now imports and reuses `LATE_SIGNAL_STORY_TYPES` in both `fetchScoutData()` and `buildCognitiveState()`; `HARVEST_PUMP_EXHAUSTION_TYPES` was left unchanged.
- Extended `scripts/verifyEvidencePackets.js` with regressions for late-story flow-only handling, case-insensitive `MOVER`/`SURGE`, genuine `STAGING`/`CLUSTER`, thesis/watchlist/legacy story compatibility, zero-genuine-without-flow behavior, and id/digest stability and differentiation by `story_type`.
- Tests run: `node --check scripts/evidencePackets.js`, `node --check scripts/verifyEvidencePackets.js`, `node --check pipeline.js`, `node scripts/verifyEvidencePackets.js`, `npm install`, `npm run check`.
- Verification result: passed.
- Unresolved follow-ups: none for Phase 1; later phases remain intentionally untouched.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .codex-spec-runner/summaries/phase-1.md`
- ` M pipeline.js`
- ` M scripts/evidencePackets.js`
- ` M scripts/verifyEvidencePackets.js`
