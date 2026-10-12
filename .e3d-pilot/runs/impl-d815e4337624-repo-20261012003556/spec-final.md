# Friction-Aware Rotation Guard

## Overview

Add a shadow-first deterministic guard to `rotation_out` decisions. A rotation must clear modeled round-trip trading friction, a safety margin, and an age-based incumbency premium; respect a minimum holding period; and have a feasible buy leg before the held position is sold.

## Goals

- Reduce loss-producing short-hold rotation churn.
- Require candidate score improvement to economically justify turnover.
- Make older positions progressively harder to displace.
- Preserve the existing cooldown-based re-entry hysteresis.
- Prevent sell-only rotations when the replacement purchase is blocked.
- Default to shadow evaluation before enforcement is enabled.

## Non-Goals

- Changing candidate or position score formulas.
- Changing hard-stop, target, fraud, Harvest, manual, or trend-overlay exits.
- Editing live portfolio state or historical trades.
- Adding dashboard or performance-report UI.
- Changing position sizing outside the rotation path.
- Adding dependencies.
- Supporting an atomic live on-chain rotation. Live execution cannot be rolled back in memory.

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site. The portfolio cash field is `cash_usd`. `equityUsd()` returns `stats.equity_usd` when that value is finite, otherwise cash plus position market value. `executeSell()` mutates the portfolio and immediately appends trade, outcome, and token-risk training events to the filesystem. It reduces quantity, cost basis, and market value, and calls `setCooldown()` only when the close rule fires (`quantity <= 1e-12` or `market_value_usd < 1`). `log()` appends to the pipeline log. `buildPositionSizingDecision()` and `evaluateSellActions()` are outside the pure guard path: the former writes a training event, and the latter refreshes prices from the network. `openPosition()` writes the buy trade event only after the buy is accepted. The cycle emails `result.sellTrade` and `result.buyTrade` after `executeRotation()`.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 650 lines.
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic. `evaluateRotationActions(portfolio, approved, nowMs = Date.now())` must accept an optional third argument so existing callers stay valid and fixtures do not depend on wall-clock timing.
- Do not persist normalized settings back onto the portfolio.
- Verification must not access the network or write portfolio, log, report, state, or training files. The verifier must not call `savePortfolio`, `log`, `executeSell`, `executeRotation`, `evaluateSellActions`, or `buildPositionSizingDecision`. Importing `pipeline.js` may still create the reports directory as it does today. Read-only log tails inside `evaluateRiskDecision()` are acceptable.
- Apply minimum-hold and economic-hurdle rules only to rotations. Hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest index pairing, and `max_rotations_per_cycle`. A guard rejection drops only that pair. It must not `break` the loop and must not backfill the index with a deeper pair. Keep the existing `break` only for `score_delta < rotation_threshold`, because that threshold is monotonic and later pairs are not.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow. Enforcement requires an explicit setting change.
- Read-time normalization: mode is `"off"`, `"shadow"`, or `"enforce"`, otherwise `"shadow"`. A non-finite or negative numeric guard setting falls back to its `SETTINGS_DEFAULTS` value. Zero is valid. Do not throw.


## Phase 1 - Shared Rotation Allocation Helper

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->


**Token budget:** `pipeline.js` is ~512 KB. Never read it whole. Locate functions with `grep -n` and read only bounded line ranges around them. Do not re-read files you already edited. While iterating, run only `node scripts/verifyRotationFrictionGuard.js`; run the full `npm install && npm run check` exactly once at the end, and do not paste its output back into your reasoning. Reuse the fixture builders already in `scripts/verifyRotationFrictionGuard.js` instead of writing new ones or exploring `pipeline.js` for fixture shapes.

### Requirements

Implement only this phase. Do not add the feasibility helper, guard, or settings; later phases do that. This change set deliberately does not include an atomic sell-then-buy commit; that is deferred.

1. Add the exported `resolveRotationAllocationUsd(postSellPortfolio, candidate, expectedNetProceedsUsd, review = null, positionSizing = null)` helper, and refactor `executeRotation()` onto it. Formula:

   Use it only for rotation buys, never ordinary buys. Percents are fractions of `equityUsd(postSellCopy)`, preserving that function's preference for a finite `stats.equity_usd`. The USD allocation is:
   
      - `desiredPct` is `review`-independent `_risk.approved_size_pct / 100` when that percent is positive, otherwise `risk_per_trade_pct`;
      - if `review.approved_size_pct / 100` is positive, cap `desiredPct` by it;
      - cap by `max_position_pct`;
      - USD cap is the minimum of post-sell `cash_usd`, `equityUsd(postSellCopy) * allocPct`, and expected net sell proceeds;
      - also cap by `position_sizing.max_allocation_usd` when that value is present;
      - remaining category headroom is `category_cap_pct - categoryExposurePct(postSellCopy, category)`; when headroom is positive, also cap by `equityUsd(postSellCopy) * headroom`;
      - then reduce the notional with `buildPaperFillExecution` so the paper buy debit, notional plus fee, fits in post-sell `cash_usd`.
   
      

2. (spec item 6)

6. Refactor `executeRotation()` onto `resolveRotationAllocationUsd` so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.


3. Create `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict` and add syntax checking plus execution of it to the existing `package.json` `check` command without removing or reordering existing checks. In this phase it covers only: the allocation helper applying percent caps to `equityUsd()` rather than treating a percent as USD, caps by `max_position_pct` / post-sell cash / net proceeds / category headroom, and no filesystem writes beyond the existing `pipeline.js` import side effect.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Rotation allocation in `executeRotation()` is unchanged in behavior on today's inputs.

## Phase 2 - Rotation Buy-Leg Feasibility Helper

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->


**Token budget:** `pipeline.js` is ~512 KB. Never read it whole. Locate functions with `grep -n` and read only bounded line ranges around them. Do not re-read files you already edited. While iterating, run only `node scripts/verifyRotationFrictionGuard.js`; run the full `npm install && npm run check` exactly once at the end, and do not paste its output back into your reasoning. Reuse the fixture builders already in `scripts/verifyRotationFrictionGuard.js` instead of writing new ones or exploring `pipeline.js` for fixture shapes.

### Requirements

Phase 1 is already implemented (`resolveRotationAllocationUsd` and `scripts/verifyRotationFrictionGuard.js`). Build on it; extend the verification script.

1. (spec item 5) Add the pure, exported `evaluateRotationBuyFeasibility` helper and the exported `resolveRotationAllocationUsd` helper described below.

5. Add a pure, exported `evaluateRotationBuyFeasibility` helper that evaluates a proposed rotation before selling. It must not mutate the caller's portfolio, call the network, call live execution, or record training, evidence, or log events. It must not call `recordRiskEngineDecisionEvent`. Build an in-memory post-sell copy by applying the same economic mutations as `executeSell()`:

   - estimate the sold quantity from `rotation_sell_fraction` and the net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as the paper branch of `executeSell()`;
   - add those net proceeds to `cash_usd`;
   - reduce quantity, `cost_basis_usd`, and `market_value_usd` by the same fraction rules as `executeSell()`;
   - remove the position when the remaining quantity is at most `1e-12` or the remaining market value is below 1;
   - push the simulated sell onto both `closed_trades` and `action_history` so risk checks see the same post-sell book `executeRotation()` sees today. The simulated sell record MUST carry a real parseable ISO `ts` (never `null`) equal to the evaluation timestamp passed to `evaluateRiskDecision` (derive it from the injected clock/`nowMs`; default to the real clock when none is injected), plus every field of `executeSell()`'s record that the daily-PnL, rolling-24h-loss, and daily-turnover checks read (side, symbol, pnl_usd, proceeds/notional, ts), so all three limits see the simulated sell exactly as they will see the real one;
   - do not call `setCooldown()` on the copy. Slot and category checks depend on the position book, not the cooldown map.

   Reuse one exported `resolveRotationAllocationUsd` helper for both this estimate and `executeRotation()`. Do not use it for ordinary buys. Percents are fractions of `equityUsd(postSellCopy)`, preserving that function's preference for a finite `stats.equity_usd`. The USD allocation is:

   - `desiredPct` is `review`-independent `_risk.approved_size_pct / 100` when that percent is positive, otherwise `risk_per_trade_pct`;
   - if `review.approved_size_pct / 100` is positive, cap `desiredPct` by it;
   - cap by `max_position_pct`;
   - USD cap is the minimum of post-sell `cash_usd`, `equityUsd(postSellCopy) * allocPct`, and expected net sell proceeds;
   - also cap by `position_sizing.max_allocation_usd` when that value is present;
   - remaining category headroom is `category_cap_pct - categoryExposurePct(postSellCopy, category)`; when headroom is positive, also cap by `equityUsd(postSellCopy) * headroom`;
   - then reduce the notional with `buildPaperFillExecution` so the paper buy debit, notional plus fee, fits in post-sell `cash_usd`.

   `evaluateRotationActions()` runs before executor review and before `buildPositionSizingDecision()`, so those caps are absent there. `executeRotation()` recomputes feasibility with the executor review and the action's `position_sizing`. Do not call `buildPositionSizingDecision()` from either helper.

   Return `{ feasible, reason_codes, allocation_usd }`. Report every applicable stable blocker code. This phase implements the codes listed below; the `thesis_cap_reached` and `risk_decision_block` codes are added in the next phase, so do not implement them here:

   - `missing_or_invalid_price`
   - `candidate_identity_conflict` when `resolveExistingPositionKey` reports a `conflict` for the candidate, or resolves it to an existing held position other than the one being sold (the same conditions under which `openPosition()` would reject the buy)
   - `sell_leg_unavailable` when the held position is missing or the simulated sell produces a non-positive quantity or a rejected fill. `feasible: false` must never come with an empty `reason_codes` array.
   - `category_exposure_cap_reached` when post-sell category headroom is `<= 0`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`

   Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.



Extend `scripts/verifyRotationFrictionGuard.js` to cover at least: a category-cap block on the post-sell book; an allocation below `min_trade_usd`; an invalid candidate price; a partial rotation that cannot free a position slot; a full-book rotation whose sell closes the position not being slot-blocked; the helper never mutating its input portfolio; no filesystem writes.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Feasibility uses the simulated post-sell book and never mutates the caller's portfolio.

## Phase 3 - Feasibility: Thesis-Cap and Risk-Decision Blockers

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->


**Token budget:** `pipeline.js` is ~512 KB. Never read it whole. Locate functions with `grep -n` and read only bounded line ranges around them. Do not re-read files you already edited. While iterating, run only `node scripts/verifyRotationFrictionGuard.js`; run the full `npm install && npm run check` exactly once at the end, and do not paste its output back into your reasoning. Reuse the fixture builders already in `scripts/verifyRotationFrictionGuard.js` instead of writing new ones or exploring `pipeline.js` for fixture shapes.

### Requirements

Phases 1 and 2 are already implemented (`resolveRotationAllocationUsd`, `evaluateRotationBuyFeasibility` with price, category, minimum-trade, and slot blockers, and `scripts/verifyRotationFrictionGuard.js`). Extend `evaluateRotationBuyFeasibility` with two more stable blocker codes, evaluated on the same simulated post-sell copy, still pure (no network, no recording, no mutation of the caller's portfolio, never call `recordRiskEngineDecisionEvent`):

   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule, including the trend-overlay and cash-equivalent exclusions in `countThesisPositions()`
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as today's rotation buy (`buildBuyRiskIntent(candidate, allocationUsd, "rotation")`), has `decision === "block"`

Extend `scripts/verifyRotationFrictionGuard.js` to cover: a thesis-cap block when the simulated sell does not free a thesis slot (including the trend-overlay and cash-equivalent exclusions in `countThesisPositions()`); a risk decision of `block` on the post-sell copy; that a full-book rotation whose sell closes the position is not blocked for thesis slot headroom.

4. In `executeRotation()`, before any sell, call `evaluateRotationBuyFeasibility` with the executor `review` and `action.position_sizing`; if infeasible, return `null` without mutating the portfolio or writing any record. Do not add any other behavior to `executeRotation()`.

Also cover in `scripts/verifyRotationFrictionGuard.js`: the simulated sell carries a finite parseable `ts` equal to the injected evaluation time; a rolling-24h-loss limit and a daily-turnover limit that are breached only once the simulated sell is counted each yield `risk_decision_block`; `candidate_identity_conflict` blocks; a missing held position yields `sell_leg_unavailable` with a non-empty `reason_codes`.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- `reason_codes` lists every applicable blocker and is never empty when `feasible` is false; feasibility remains pure.
- The simulated sell is timestamped so rolling-loss and turnover limits see it.

## Phase 4 - Friction Guard Function and Settings

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->


**Token budget:** `pipeline.js` is ~512 KB. Never read it whole. Locate functions with `grep -n` and read only bounded line ranges around them. Do not re-read files you already edited. While iterating, run only `node scripts/verifyRotationFrictionGuard.js`; run the full `npm install && npm run check` exactly once at the end, and do not paste its output back into your reasoning. Reuse the fixture builders already in `scripts/verifyRotationFrictionGuard.js` instead of writing new ones or exploring `pipeline.js` for fixture shapes.

### Requirements

Phases 1 through 3 are already implemented (`resolveRotationAllocationUsd`, `evaluateRotationBuyFeasibility` with all blocker codes, `scripts/verifyRotationFrictionGuard.js`, and its `check` wiring). Build on it; do not redo it. Implement only the settings and the pure guard function; do not touch `evaluateRotationActions()` or the cycle call site (the next phase does that). Extend the existing verification script.

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.


2. Add and export `evaluateRotationGuard`. It accepts the held position, replacement candidate, score delta, settings, injected `nowMs`, and a buy-leg feasibility result. It returns:

   - `mode`
   - `allow`
   - `would_block`
   - `reason_codes`
   - `diagnostic_reason_codes`
   - `held_hours` (`null` when age is unknown)
   - `score_delta`
   - `modeled_edge_bps`
   - `round_trip_cost_bps`
   - `margin_bps`
   - `age_hysteresis_bps`
   - `required_edge_bps`
   - `buy_feasibility`

   Parse `opened_at` with `Date.parse`. A missing value or a non-finite parse is unavailable. Do not treat a missing age as zero hours.

   Round `modeled_edge_bps`, `round_trip_cost_bps`, `margin_bps`, and `age_hysteresis_bps` to 6 decimal places with half-away-from-zero rounding. `required_edge_bps` is the sum of the three rounded cost, margin, and hysteresis components, rounded the same way. Compare the rounded edge with the rounded requirement. Exact equality passes.

   `reason_codes` contains only rules that make `allow` false in the active mode. `diagnostic_reason_codes` contains `opened_at_unavailable` when age is unknown, plus `minimum_hold_not_met` and `friction_hurdle_not_cleared` when those conditions are true but the active mode does not enforce them. Buy-leg blocker codes live on `buy_feasibility.reason_codes` and are copied into `reason_codes` when the buy leg is infeasible.

   `allow` is false only when the active mode omits the pair, and is always false whenever `buy_feasibility.feasible === false`, including when its `reason_codes` is empty (then `reason_codes` gets `buy_leg_infeasible`). `would_block` is true when enforce mode would omit the pair, including when the buy leg is infeasible, regardless of the active mode.


3. Calculate age and the economic hurdle as:

   held_hours = max(0, (nowMs - opened_at_ms) / 3600000) when opened_at parses to a finite opened_at_ms
   held_days = held_hours / 24

   modeled_edge_bps = max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps = min(rotation_hysteresis_max_bps, max(0, held_days) * rotation_hysteresis_bps_per_day)

   required_edge_bps = rotation_round_trip_cost_bps + rotation_margin_bps + age_hysteresis_bps

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0`, sets `held_hours` to null, and still runs this comparison. Unknown age does not emit `friction_hurdle_not_cleared` merely because age is missing; a failed numeric comparison still emits it.

4. Emit `minimum_hold_not_met` when a finite `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A future but finite `opened_at` clamps `held_hours` to 0 and is subject to the minimum hold. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable` and must not invent an age or block the rotation by itself.


Extend `scripts/verifyRotationFrictionGuard.js` to cover at least: a two-hour-old position fails the minimum hold; a position older than the minimum still fails when modeled edge does not clear cost plus margin; a sufficiently strong candidate clears the hurdle; increasing held age increases the capped incumbency hurdle using fractional days; the hysteresis cap is honored; exact equality with the required edge passes; missing or malformed `opened_at` produces diagnostic `opened_at_unavailable`, leaves `held_hours` null, and is not an age block; unknown age still emits `friction_hurdle_not_cleared` when rounded edge is below cost plus margin with zero hysteresis; mode normalization of invalid settings; the guard never throws.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- `evaluateRotationGuard` is pure, exported, never throws, and defaults to shadow mode.

## Phase 5 - Guard Integration into Rotation Pairing

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->


**Token budget:** `pipeline.js` is ~512 KB. Never read it whole. Locate functions with `grep -n` and read only bounded line ranges around them. Do not re-read files you already edited. While iterating, run only `node scripts/verifyRotationFrictionGuard.js`; run the full `npm install && npm run check` exactly once at the end, and do not paste its output back into your reasoning. Reuse the fixture builders already in `scripts/verifyRotationFrictionGuard.js` instead of writing new ones or exploring `pipeline.js` for fixture shapes.

**Fixture hints for this phase (so you need not explore):** `rankApprovedCandidates` filters on active cooldowns and sorts by `candidate._score` descending; a candidate is `{ token: { symbol, contract_address, category }, _score, _risk: { approved_size_pct } }` (plus a positive `price` or `last_market_snapshot.market_data.current_price` for feasibility). `rankHeldPositions` scores each held position with `computePositionScore(position, settings)`, which is `conviction_score*0.35 + liquidity_quality*0.30 - fraud_risk*0.25 + 0.1*pnl_pct` (plus a 15 bonus for thesis-like `setup_type`), so set `conviction_score` and `liquidity_quality` on held fixtures to control scores deterministically. Held positions are paired weakest-first (`rankedHeld[length-1-i]`). Cap this phase's new tests at about eight focused cases.

### Requirements

Phases 1 through 4 are already implemented (`resolveRotationAllocationUsd`, `evaluateRotationBuyFeasibility`, the settings defaults, exported `evaluateRotationGuard`, and `scripts/verifyRotationFrictionGuard.js`). Build on them; do not redo them. Change only `evaluateRotationActions()` (add the optional `nowMs = Date.now()` third argument); do not touch the cycle call site (Phase 6 does that). Extend the existing verification script.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: do not omit a pair for minimum hold, friction, margin, or age hysteresis. Still attach `rotation_guard`. `would_block` still reflects what enforce mode would do.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible. `allow` stays true when the only failures are minimum hold or the friction hurdle. `would_block` is true in that case, with those codes on `diagnostic_reason_codes`.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`. For an omitted pair, `allow` is false and `would_block` is true.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule. For those pairs, `allow` is false and `would_block` is true.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

Extend `scripts/verifyRotationFrictionGuard.js` to cover at least: `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics and `allow: true`; `"enforce"` removes that action and still evaluates a later pair that clears the threshold; `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible; buy infeasibility blocks in all modes; active cooldown filtering still prevents immediate re-entry; `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle without skipping later pairs that still clear `rotation_threshold`.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact. Non-rotation exits are unaffected.

## Phase 6 - Cycle Call Site: nowMs and Shadow Log

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->


**Token budget:** `pipeline.js` is ~512 KB. Never read it whole. Locate functions with `grep -n` and read only bounded line ranges around them. Do not re-read files you already edited. While iterating, run only `node scripts/verifyRotationFrictionGuard.js`; run the full `npm install && npm run check` exactly once at the end, and do not paste its output back into your reasoning. Reuse the fixture builders already in `scripts/verifyRotationFrictionGuard.js` instead of writing new ones or exploring `pipeline.js` for fixture shapes.

### Requirements

Phases 1 through 5 are already implemented (the allocation and feasibility helpers, the settings, `evaluateRotationGuard`, and `evaluateRotationActions(portfolio, approved, nowMs)` attaching `rotation_guard` to returned actions, and `scripts/verifyRotationFrictionGuard.js`). Build on them; do not redo them. Change only the rotation section of the main cycle. Do not change `executeRotation()`, `executeSell()`, or any email behavior.

8. At the cycle call site, pass one `nowMs` into `evaluateRotationActions()`. When the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, `reason_codes`, and `diagnostic_reason_codes`. Include `evaluated_at` from that same injected `nowMs`. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.



Extend `scripts/verifyRotationFrictionGuard.js` with a small source-level check (no execution of the cycle) that the cycle call site passes `nowMs` to `evaluateRotationActions` and emits `rotation_guard_shadow` only for the normalized `"shadow"` mode. Read only the last 120 lines of that script before appending.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- In shadow mode one `rotation_guard_shadow` event is logged per returned action carrying `rotation_guard`; none in `off` or `enforce`.
- `executeRotation()` and rotation email behavior are unchanged.
- Only `pipeline.js`, `scripts/verifyRotationFrictionGuard.js`, and the `package.json` check script change.
