# Phase 2 Summary

- Phase: 2
- Title: Rotation Buy-Leg Feasibility Helper
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-10-11T21:25:31-0700
- Exit status: 0

## Implementation Handoff

- Phase implemented: Rotation Buy-Leg Feasibility Helper.
- Added exported `evaluateRotationBuyFeasibility(portfolio, action, review = null, positionSizing = null, nowMs = Date.now())` in `pipeline.js`.
- The helper is pure: it deep-clones the input portfolio, performs an in-memory paper sell simulation, never logs, never records training/risk events, never calls live execution, and never mutates the caller.
- The simulated sell mirrors `executeSell()` economics for paper mode: fraction-based quantity reduction, paper fill pricing/fees, cash increase by net proceeds, cost basis and market value reduction, close-on-dust removal, and a simulated sell entry appended to both `closed_trades` and `action_history`.
- Simulated sell records now carry a real ISO `ts` derived from injected `nowMs`, plus the sell fields the risk engine reads (`side`, `symbol`, `pnl_usd`, `proceeds_usd`, `gross_proceeds_usd`, `ts`).
- Feasibility returns `{ feasible, reason_codes, allocation_usd }` and currently implements Phase 2 blocker codes only: `missing_or_invalid_price`, `candidate_identity_conflict`, `sell_leg_unavailable`, `category_exposure_cap_reached`, `below_min_trade_usd`, and `position_slot_unavailable`.
- Category and slot checks run against the simulated post-sell book, so a full book can rotate when the sell closes the outgoing position.
- Reused the existing exported `resolveRotationAllocationUsd()` helper for post-sell rotation sizing; ordinary buy sizing remains unchanged.
- Extended `scripts/verifyRotationFrictionGuard.js` to cover post-sell category-cap blocking, below-min-trade blocking, invalid price blocking, partial-rotation slot blocking, full-close non-slot blocking, immutability of the input portfolio, and no filesystem writes beyond import side effects.
- Tests run during iteration: `node scripts/verifyRotationFrictionGuard.js`.
- Final verification run: `npm install && npm run check`.
- Verification result: passed.
- Unresolved follow-ups: Phase 3 still needs `thesis_cap_reached`, `risk_decision_block`, and the pre-sell feasibility gate wired into `executeRotation()`.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .spec2code/manifest.tsv`
- ` M .spec2code/summaries/phase-1.md`
- ` M .spec2code/summaries/phase-2.md`
- ` M package.json`
- ` M pipeline.js`
- `?? scripts/verifyRotationFrictionGuard.js`
