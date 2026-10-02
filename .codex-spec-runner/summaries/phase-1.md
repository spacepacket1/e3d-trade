# Phase 1 Summary

- Phase: 1
- Title: Flow-Only Eligibility and Per-Cycle Admission
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-10-02T06:39:43-0700
- Exit status: 0

## Implementation Handoff

- Phase implemented: Flow-Only Eligibility and Per-Cycle Admission.
- Updated `scripts/evidencePackets.js` to raise `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
- Preserved the canonical flow-only classifier: genuine story evidence count must be `0` and at least one evidence item must still have `source_type === "flow"`.
- Changed `evaluateScoutPacketEligibility()` so flow-only packets no longer consult `buy_sell_ratio_1h`.
- Missing, null, and blank `flow_signal` values now pass the flow-signal condition; any cleaned lowercase signal containing `distribution` still fails.
- Left `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported and unchanged for compatibility.
- Extended `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet that stays canonically flow-only via explicit flow evidence and passes with absent/null DEX flow measurements.
- Added regressions for `distribution` and `strong_distribution`, missing/null/blank flow signals, independent liquidity/volume/market-cap failures, and buy/sell ratio no longer affecting the result.
- Extended `scripts/verifyScoutRelaxation.js` with a two-candidate canonically flow-only shortlist fixture and asserted one shortlist admission plus one `flow_only_cap_exceeded` block.
- Tests run: `node --check scripts/evidencePackets.js`, `node --check scripts/verifyEvidencePackets.js`, `node --check scripts/verifyScoutRelaxation.js`, `node scripts/verifyEvidencePackets.js`, `node scripts/verifyScoutRelaxation.js`, `npm install`, `npm run check`.
- Verification result: passed.
- Unresolved follow-ups: none for this phase; later phases were intentionally not implemented.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .codex-spec-runner/summaries/phase-1.md`
- ` M scripts/evidencePackets.js`
- ` M scripts/verifyEvidencePackets.js`
- ` M scripts/verifyScoutRelaxation.js`
