---
run_id: impl-d815e4337624-repo-20261012003556
---

# Negotiation Log

## Round 1

### Draft Before Round

```text
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

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 600 lines.
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic; do not depend on wall-clock timing in fixtures.
- Verification must not access the network or write portfolio, log, report, state, or training files.
- Apply minimum-hold and economic-hurdle rules only to rotations; hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest pairing, and `max_rotations_per_cycle`.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow; enforcement requires an explicit setting change.

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`, accepting only `"off"`, `"shadow"`, or `"enforce"` and falling back to `"shadow"` for invalid values.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.

2. Add and export a pure rotation-guard evaluator accepting the held position, replacement candidate, score delta, settings, injected `nowMs`, and buy-leg feasibility. It must return structured data containing at least:

   - normalized mode;
   - `allow`;
   - stable reason codes;
   - held hours;
   - score delta;
   - modeled edge basis points;
   - round-trip cost basis points;
   - margin basis points;
   - age-hysteresis basis points;
   - total required basis points;
   - buy-feasibility details.

3. Calculate the economic hurdle as:

   ```text
   modeled_edge_bps =
     max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps =
     min(
       rotation_hysteresis_max_bps,
       max(0, held_days) * rotation_hysteresis_bps_per_day
     )

   required_edge_bps =
     rotation_round_trip_cost_bps
     + rotation_margin_bps
     + age_hysteresis_bps
   ```

   Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. This rule supplements, rather than removes, the existing `rotation_threshold` check.

4. Emit `minimum_hold_not_met` when a valid `opened_at` shows the position is younger than `rotation_min_hold_hours`. A missing or invalid `opened_at` must be surfaced in guard diagnostics but must not invent an age or independently block the rotation.

5. Add a pure, exported buy-leg feasibility helper that evaluates a proposed rotation before selling. It must reuse the sizing inputs and constraints used by `executeRotation()` and report stable blocker codes for all deterministic pre-buy failures, including:

   - missing or invalid candidate price;
   - no category headroom;
   - estimated allocation below `min_trade_usd`;
   - insufficient position-slot headroom when the proposed sell would not close the old position;
   - any deterministic risk decision that would block the rotation buy.

   The estimate must include the proposed sell fraction and expected proceeds so it reflects the post-sell portfolio without mutating it.

6. Refactor shared rotation allocation calculations into reusable helpers instead of maintaining separate formulas in evaluation and execution.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate/position pairing:

   - `"off"`: skip minimum-hold, friction, margin, and age-hysteresis gating.
   - `"shadow"`: retain qualifying actions under existing behavior, attach guard diagnostics, and record that an action would have been blocked.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule.

8. At the cycle call site, emit one structured `rotation_guard_shadow` pipeline event per shadow-evaluated action. Include timestamp, source and destination symbols, mode, score delta, held hours, modeled edge, required edge, component costs, `allow`, and reason codes. Use the existing pipeline logger; do not add a new log file.

9. Before `executeRotation()` invokes `executeSell()`, recompute feasibility using the executor-approved size. If it is no longer feasible, return a structured blocked result without selling. No completed rotation may return or persist a non-null sell trade with a null buy trade. If an unexpected post-sell buy failure occurs, restore the in-memory portfolio snapshot before persistence and surface a failed rotation result rather than a sale.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Cover at least:

   - a two-hour-old position fails the minimum hold;
   - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
   - a sufficiently strong candidate clears the hurdle;
   - increasing held age increases the capped incumbency hurdle;
   - the hysteresis cap is honored;
   - exact equality with the required edge passes;
   - missing or malformed `opened_at` is diagnostic but not an age block;
   - a category-cap block makes the buy leg infeasible;
   - an estimated allocation below `min_trade_usd` is infeasible;
   - a partial rotation that cannot free a position slot is infeasible;
   - `"shadow"` retains an action while exposing would-block diagnostics;
   - `"enforce"` removes that same action;
   - `"off"` preserves existing threshold behavior;
   - buy infeasibility blocks in all modes;
   - active cooldown filtering still prevents immediate re-entry;
   - hard-sell evaluation is unchanged by rotation guard settings;
   - the tested path performs no filesystem writes.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or broadening any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle.
- Older held positions require a larger candidate advantage, up to the configured cap.
- A category-capped, undersized, invalid-price, risk-blocked, or slot-infeasible buy leg cannot trigger a sale.
- No successful rotation result contains a sell without its corresponding buy.
- Existing rotation ranking, pairing, cycle caps, and cooldown behavior remain intact.
- Non-rotation exits remain unaffected.
- No protected path is modified.

```

### Reviewer 1: grok-build

Status: revise

Reason: Buy-leg checks, rollback, and hold rules are underspecified against executeSell side effects, post-sell risk state, and non-monotonic pair ages.

Replacement Spec:

```spec
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

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site. `executeSell()` mutates the portfolio and immediately appends trade, outcome, and token-risk training events. `log()` appends to the pipeline log. `buildPositionSizingDecision()` and `evaluateSellActions()` are outside the pure guard path: the former writes a training event, and the latter refreshes prices from the network.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 600 lines.
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic. `evaluateRotationActions(portfolio, approved, nowMs = Date.now())` must accept an optional third argument so existing callers stay valid and fixtures do not depend on wall-clock timing.
- Do not persist normalized settings back onto the portfolio.
- Verification must not access the network or write portfolio, log, report, state, or training files. The verifier must not call `savePortfolio`, `log`, `executeSell`, `executeRotation`, `evaluateSellActions`, or `buildPositionSizingDecision`. Importing `pipeline.js` may still create the reports directory as it does today.
- Apply minimum-hold and economic-hurdle rules only to rotations. Hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest index pairing, and `max_rotations_per_cycle`. A guard rejection drops only that pair. It must not `break` the loop and must not backfill the index with a deeper pair. Keep the existing `break` only for `score_delta < rotation_threshold`, because that threshold is monotonic and later pairs are not.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow. Enforcement requires an explicit setting change.
- Read-time normalization: mode is `"off"`, `"shadow"`, or `"enforce"`, otherwise `"shadow"`. A non-finite or negative numeric guard setting falls back to its `SETTINGS_DEFAULTS` value. Do not throw.

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.

2. Add and export a pure rotation-guard evaluator. It accepts the held position, replacement candidate, score delta, settings, injected `nowMs`, and buy-leg feasibility. It returns:

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

   Round each basis-point component to 6 decimal places before comparison. `allow` is false when a rule blocks in the active mode. `would_block` is true when enforce mode would drop the pair or the buy leg is infeasible.

3. Calculate age and the economic hurdle as:

   ```text
   held_hours = max(0, (nowMs - opened_at_ms) / 3600000)
   held_days = held_hours / 24

   modeled_edge_bps =
     max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps =
     min(
       rotation_hysteresis_max_bps,
       max(0, held_days) * rotation_hysteresis_bps_per_day
     )

   required_edge_bps =
     rotation_round_trip_cost_bps
     + rotation_margin_bps
     + age_hysteresis_bps
   ```

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. Exact equality passes. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0` and does not emit `friction_hurdle_not_cleared` by itself.

4. Emit `minimum_hold_not_met` when a valid `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable`, leaves `held_hours` null, and must not invent an age or independently block the rotation.

5. Add a pure, exported buy-leg feasibility helper that evaluates a proposed rotation before selling. It must not mutate the portfolio, call the network, call live execution, or record training, evidence, or log events. Build an in-memory post-sell copy:

   - estimate sell quantity from `rotation_sell_fraction` and net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as `executeSell()`;
   - add those net proceeds to cash;
   - reduce the held position by the sold quantity and market value;
   - remove it when the remaining quantity is at most `1e-12` or the remaining market value is below 1, matching `executeSell()`'s close rule;
   - include the simulated sell on the copy's closed trades so risk turnover sees the same post-sell book `executeRotation()` sees today.

   Reuse one exported allocation helper for both this estimate and `executeRotation()`. The allocation is the post-sell form of the current executor formula: risk-approved percent when positive, otherwise `risk_per_trade_pct`, optionally capped by `review.approved_size_pct`, then capped by `max_position_pct`, post-sell cash, expected net proceeds, `position_sizing.max_allocation_usd` when present, and remaining post-sell category headroom. Cap the notional so the paper buy debit, notional plus fee, fits in post-sell cash.

   Report these stable blocker codes when they apply:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as the rotation buy, has `decision === "block"`

   Do not call `recordRiskEngineDecisionEvent` from the helper. Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor that shared allocation helper so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: skip minimum-hold, friction, margin, and age-hysteresis gating.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible, attach `rotation_guard`, and set `would_block` when enforce mode would have removed the action.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, when the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, and reason codes. Include `evaluated_at` from the injected evaluation time. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Before `executeRotation()` invokes `executeSell()`, recompute feasibility with the executor-approved size. If it is infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` and do not sell. A committed rotation returns `{ status: "filled", sell_trade, buy_trade }` with both trades non-null. No completed rotation may return or persist a sell without its buy.

   `executeSell()` already appends training events before it returns. The rotation path must defer trade, outcome, token-risk, evidence, cooldown commit, and the cycle's trade email until the buy leg returns a trade. Default `executeSell()` behavior for hard-risk, Harvest, and manual sells stays unchanged. If the in-memory sell succeeds and the buy then returns null, restore cash, positions, `closed_trades`, `action_history`, and cooldowns from the pre-sell snapshot; write no training or evidence record for the discarded sell; and return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`. The cycle site must not email a null sell trade.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown only when the rotation fills. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces `opened_at_unavailable` and is not an age block;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no training or evidence record.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact.
- Non-rotation exits remain unaffected.
- No protected path is modified.
```

Raw Response:

```text
I'll review the draft against the rotation code it names so the verdict is based on whether the spec is implementable as written.---STATUS---
status: revise
reason: Buy-leg checks, rollback, and hold rules are underspecified against executeSell side effects, post-sell risk state, and non-monotonic pair ages.

```spec
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

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site. `executeSell()` mutates the portfolio and immediately appends trade, outcome, and token-risk training events. `log()` appends to the pipeline log. `buildPositionSizingDecision()` and `evaluateSellActions()` are outside the pure guard path: the former writes a training event, and the latter refreshes prices from the network.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 600 lines.
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic. `evaluateRotationActions(portfolio, approved, nowMs = Date.now())` must accept an optional third argument so existing callers stay valid and fixtures do not depend on wall-clock timing.
- Do not persist normalized settings back onto the portfolio.
- Verification must not access the network or write portfolio, log, report, state, or training files. The verifier must not call `savePortfolio`, `log`, `executeSell`, `executeRotation`, `evaluateSellActions`, or `buildPositionSizingDecision`. Importing `pipeline.js` may still create the reports directory as it does today.
- Apply minimum-hold and economic-hurdle rules only to rotations. Hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest index pairing, and `max_rotations_per_cycle`. A guard rejection drops only that pair. It must not `break` the loop and must not backfill the index with a deeper pair. Keep the existing `break` only for `score_delta < rotation_threshold`, because that threshold is monotonic and later pairs are not.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow. Enforcement requires an explicit setting change.
- Read-time normalization: mode is `"off"`, `"shadow"`, or `"enforce"`, otherwise `"shadow"`. A non-finite or negative numeric guard setting falls back to its `SETTINGS_DEFAULTS` value. Do not throw.

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.

2. Add and export a pure rotation-guard evaluator. It accepts the held position, replacement candidate, score delta, settings, injected `nowMs`, and buy-leg feasibility. It returns:

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

   Round each basis-point component to 6 decimal places before comparison. `allow` is false when a rule blocks in the active mode. `would_block` is true when enforce mode would drop the pair or the buy leg is infeasible.

3. Calculate age and the economic hurdle as:

   ```text
   held_hours = max(0, (nowMs - opened_at_ms) / 3600000)
   held_days = held_hours / 24

   modeled_edge_bps =
     max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps =
     min(
       rotation_hysteresis_max_bps,
       max(0, held_days) * rotation_hysteresis_bps_per_day
     )

   required_edge_bps =
     rotation_round_trip_cost_bps
     + rotation_margin_bps
     + age_hysteresis_bps
   ```

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. Exact equality passes. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0` and does not emit `friction_hurdle_not_cleared` by itself.

4. Emit `minimum_hold_not_met` when a valid `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable`, leaves `held_hours` null, and must not invent an age or independently block the rotation.

5. Add a pure, exported buy-leg feasibility helper that evaluates a proposed rotation before selling. It must not mutate the portfolio, call the network, call live execution, or record training, evidence, or log events. Build an in-memory post-sell copy:

   - estimate sell quantity from `rotation_sell_fraction` and net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as `executeSell()`;
   - add those net proceeds to cash;
   - reduce the held position by the sold quantity and market value;
   - remove it when the remaining quantity is at most `1e-12` or the remaining market value is below 1, matching `executeSell()`'s close rule;
   - include the simulated sell on the copy's closed trades so risk turnover sees the same post-sell book `executeRotation()` sees today.

   Reuse one exported allocation helper for both this estimate and `executeRotation()`. The allocation is the post-sell form of the current executor formula: risk-approved percent when positive, otherwise `risk_per_trade_pct`, optionally capped by `review.approved_size_pct`, then capped by `max_position_pct`, post-sell cash, expected net proceeds, `position_sizing.max_allocation_usd` when present, and remaining post-sell category headroom. Cap the notional so the paper buy debit, notional plus fee, fits in post-sell cash.

   Report these stable blocker codes when they apply:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as the rotation buy, has `decision === "block"`

   Do not call `recordRiskEngineDecisionEvent` from the helper. Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor that shared allocation helper so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: skip minimum-hold, friction, margin, and age-hysteresis gating.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible, attach `rotation_guard`, and set `would_block` when enforce mode would have removed the action.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, when the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, and reason codes. Include `evaluated_at` from the injected evaluation time. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Before `executeRotation()` invokes `executeSell()`, recompute feasibility with the executor-approved size. If it is infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` and do not sell. A committed rotation returns `{ status: "filled", sell_trade, buy_trade }` with both trades non-null. No completed rotation may return or persist a sell without its buy.

   `executeSell()` already appends training events before it returns. The rotation path must defer trade, outcome, token-risk, evidence, cooldown commit, and the cycle's trade email until the buy leg returns a trade. Default `executeSell()` behavior for hard-risk, Harvest, and manual sells stays unchanged. If the in-memory sell succeeds and the buy then returns null, restore cash, positions, `closed_trades`, `action_history`, and cooldowns from the pre-sell snapshot; write no training or evidence record for the discarded sell; and return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`. The cycle site must not email a null sell trade.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown only when the rotation fills. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces `opened_at_unavailable` and is not an age block;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no training or evidence record.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact.
- Non-rotation exits remain unaffected.
- No protected path is modified.
```
```

### Reviewer 2: claude

Status: approved

Reason: The spec is complete, internally consistent, and testable, with clear scope limits, shadow-first rollout, atomic buy-leg safety, and a thorough verification plan.

Raw Response:

```text
---STATUS---
status: approved
reason: The spec is complete, internally consistent, and testable, with clear scope limits, shadow-first rollout, atomic buy-leg safety, and a thorough verification plan.
```

### Reviewer 3: codex

Status: approved

Reason: The draft is internally consistent, implementation-ready, and defines verifiable safety, rollout, atomicity, and regression requirements.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, implementation-ready, and defines verifiable safety, rollout, atomicity, and regression requirements.
```

### Reviewer 4: devin

Status: revise

Reason: Requirement 9 leaves the deferred-write / rollback mechanism fatally underspecified: executeSell() already appends training events to filesystem before returning, so "write no training or evidence record for the discarded sell" is impossible to satisfy without an explicit strategy for how executeRotation() avoids or reverses those writes.

Replacement Spec:

```spec
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

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site. `executeSell()` mutates the portfolio and immediately appends trade, outcome, and token-risk training events to the filesystem. `log()` appends to the pipeline log. `buildPositionSizingDecision()` and `evaluateSellActions()` are outside the pure guard path: the former writes a training event, and the latter refreshes prices from the network.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 650 lines (the buy-leg feasibility helper and atomic-commit refactor are inherently verbose; do not pad but do not sacrifice correctness for line count).
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic. `evaluateRotationActions(portfolio, approved, nowMs = Date.now())` must accept an optional third argument so existing callers stay valid and fixtures do not depend on wall-clock timing.
- Do not persist normalized settings back onto the portfolio.
- Verification must not access the network or write portfolio, log, report, state, or training files. The verifier must not call `savePortfolio`, `log`, `executeSell`, `executeRotation`, `evaluateSellActions`, or `buildPositionSizingDecision`. Importing `pipeline.js` may still create the reports directory as it does today.
- Apply minimum-hold and economic-hurdle rules only to rotations. Hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest index pairing, and `max_rotations_per_cycle`. A guard rejection drops only that pair. It must not `break` the loop and must not backfill the index with a deeper pair. Keep the existing `break` only for `score_delta < rotation_threshold`, because that threshold is monotonic and later pairs are not.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow. Enforcement requires an explicit setting change.
- Read-time normalization: mode is `"off"`, `"shadow"`, or `"enforce"`, otherwise `"shadow"`. A non-finite or negative numeric guard setting falls back to its `SETTINGS_DEFAULTS` value. Do not throw.

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.

2. Add and export a pure rotation-guard evaluator. It accepts the held position, replacement candidate, score delta, settings, injected `nowMs`, and buy-leg feasibility. It returns:

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

   Round each basis-point component to 6 decimal places before comparison. `allow` is false when a rule blocks in the active mode. `would_block` is true when enforce mode would drop the pair or the buy leg is infeasible.

3. Calculate age and the economic hurdle as:

   ```text
   held_hours = max(0, (nowMs - opened_at_ms) / 3600000)
   held_days = held_hours / 24

   modeled_edge_bps =
     max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps =
     min(
       rotation_hysteresis_max_bps,
       max(0, held_days) * rotation_hysteresis_bps_per_day
     )

   required_edge_bps =
     rotation_round_trip_cost_bps
     + rotation_margin_bps
     + age_hysteresis_bps
   ```

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. Exact equality passes. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0` and does not emit `friction_hurdle_not_cleared` by itself.

4. Emit `minimum_hold_not_met` when a valid `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable`, leaves `held_hours` null, and must not invent an age or independently block the rotation.

5. Add a pure, exported buy-leg feasibility helper that evaluates a proposed rotation before selling. It must not mutate the portfolio, call the network, call live execution, or record training, evidence, or log events. Build an in-memory post-sell copy:

   - estimate sell quantity from `rotation_sell_fraction` and net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as `executeSell()`;
   - add those net proceeds to cash;
   - reduce the held position by the sold quantity and market value;
   - remove it when the remaining quantity is at most `1e-12` or the remaining market value is below 1, matching `executeSell()`'s close rule;
   - include the simulated sell on the copy's closed trades so risk turnover sees the same post-sell book `executeRotation()` sees today.

   Reuse one exported allocation helper for both this estimate and `executeRotation()`. The allocation is the post-sell form of the current executor formula: risk-approved percent when positive, otherwise `risk_per_trade_pct`, optionally capped by `review.approved_size_pct`, then capped by `max_position_pct`, post-sell cash, expected net proceeds, `position_sizing.max_allocation_usd` when present, and remaining post-sell category headroom. Cap the notional so the paper buy debit, notional plus fee, fits in post-sell cash.

   Report these stable blocker codes when they apply:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as the rotation buy, has `decision === "block"`

   Do not call `recordRiskEngineDecisionEvent` from the helper. Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor that shared allocation helper so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: skip minimum-hold, friction, margin, and age-hysteresis gating.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible, attach `rotation_guard`, and set `would_block` when enforce mode would have removed the action.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, when the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, and reason codes. Include `evaluated_at` from the injected evaluation time. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Refactor `executeRotation()` for atomic commit so that no sell-side filesystem record is written until the buy leg succeeds.

   **Deferral mechanism**: `executeRotation()` must NOT call `executeSell()` directly. Instead it must replicate the sell-side in-memory mutations inline (deducting quantity, adjusting cash, moving to `closed_trades`, creating the `rotation_out` cooldown entry) and collect all sell-side append payloads — trade record, outcome record, token-risk training event, evidence record — in local variables. Only after the buy leg returns a non-null trade are those payloads flushed to disk via the same append helpers that `executeSell()` uses today. The existing `executeSell()` function and its signature must remain unchanged; it continues to handle hard-risk, Harvest, and manual exits with immediate filesystem writes as before.

   Before executing the sell-side mutations, take a deep snapshot of all mutable portfolio fields: `cash`, `positions`, `closed_trades`, `action_history`, and cooldowns. Recompute buy-leg feasibility with the executor-approved size using the shared allocation helper. If infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` immediately without mutating any state.

   Apply the sell-side in-memory mutations. Attempt the buy. If the buy returns a non-null trade, flush all collected payloads to disk (trade, outcome, token-risk, evidence), commit the cooldown, send the cycle trade email, and return `{ status: "filled", sell_trade, buy_trade }`. Both trades must be non-null on a filled result.

   If the buy returns null after in-memory sell mutations have been applied, restore `cash`, `positions`, `closed_trades`, `action_history`, and cooldowns from the pre-sell snapshot. Do not flush any collected payload. Return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`. The cycle site must not email a null sell trade. No completed rotation may return or persist a sell without its buy.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown only when the rotation fills. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces `opened_at_unavailable` and is not an age block;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no training or evidence record.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact.
- Non-rotation exits remain unaffected.
- No protected path is modified.
```

Raw Response:

```text
---STATUS---
status: revise
reason: Requirement 9 leaves the deferred-write / rollback mechanism fatally underspecified: executeSell() already appends training events to filesystem before returning, so "write no training or evidence record for the discarded sell" is impossible to satisfy without an explicit strategy for how executeRotation() avoids or reverses those writes.

```spec
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

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site. `executeSell()` mutates the portfolio and immediately appends trade, outcome, and token-risk training events to the filesystem. `log()` appends to the pipeline log. `buildPositionSizingDecision()` and `evaluateSellActions()` are outside the pure guard path: the former writes a training event, and the latter refreshes prices from the network.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 650 lines (the buy-leg feasibility helper and atomic-commit refactor are inherently verbose; do not pad but do not sacrifice correctness for line count).
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic. `evaluateRotationActions(portfolio, approved, nowMs = Date.now())` must accept an optional third argument so existing callers stay valid and fixtures do not depend on wall-clock timing.
- Do not persist normalized settings back onto the portfolio.
- Verification must not access the network or write portfolio, log, report, state, or training files. The verifier must not call `savePortfolio`, `log`, `executeSell`, `executeRotation`, `evaluateSellActions`, or `buildPositionSizingDecision`. Importing `pipeline.js` may still create the reports directory as it does today.
- Apply minimum-hold and economic-hurdle rules only to rotations. Hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest index pairing, and `max_rotations_per_cycle`. A guard rejection drops only that pair. It must not `break` the loop and must not backfill the index with a deeper pair. Keep the existing `break` only for `score_delta < rotation_threshold`, because that threshold is monotonic and later pairs are not.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow. Enforcement requires an explicit setting change.
- Read-time normalization: mode is `"off"`, `"shadow"`, or `"enforce"`, otherwise `"shadow"`. A non-finite or negative numeric guard setting falls back to its `SETTINGS_DEFAULTS` value. Do not throw.

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.

2. Add and export a pure rotation-guard evaluator. It accepts the held position, replacement candidate, score delta, settings, injected `nowMs`, and buy-leg feasibility. It returns:

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

   Round each basis-point component to 6 decimal places before comparison. `allow` is false when a rule blocks in the active mode. `would_block` is true when enforce mode would drop the pair or the buy leg is infeasible.

3. Calculate age and the economic hurdle as:

   ```text
   held_hours = max(0, (nowMs - opened_at_ms) / 3600000)
   held_days = held_hours / 24

   modeled_edge_bps =
     max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps =
     min(
       rotation_hysteresis_max_bps,
       max(0, held_days) * rotation_hysteresis_bps_per_day
     )

   required_edge_bps =
     rotation_round_trip_cost_bps
     + rotation_margin_bps
     + age_hysteresis_bps
   ```

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. Exact equality passes. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0` and does not emit `friction_hurdle_not_cleared` by itself.

4. Emit `minimum_hold_not_met` when a valid `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable`, leaves `held_hours` null, and must not invent an age or independently block the rotation.

5. Add a pure, exported buy-leg feasibility helper that evaluates a proposed rotation before selling. It must not mutate the portfolio, call the network, call live execution, or record training, evidence, or log events. Build an in-memory post-sell copy:

   - estimate sell quantity from `rotation_sell_fraction` and net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as `executeSell()`;
   - add those net proceeds to cash;
   - reduce the held position by the sold quantity and market value;
   - remove it when the remaining quantity is at most `1e-12` or the remaining market value is below 1, matching `executeSell()`'s close rule;
   - include the simulated sell on the copy's closed trades so risk turnover sees the same post-sell book `executeRotation()` sees today.

   Reuse one exported allocation helper for both this estimate and `executeRotation()`. The allocation is the post-sell form of the current executor formula: risk-approved percent when positive, otherwise `risk_per_trade_pct`, optionally capped by `review.approved_size_pct`, then capped by `max_position_pct`, post-sell cash, expected net proceeds, `position_sizing.max_allocation_usd` when present, and remaining post-sell category headroom. Cap the notional so the paper buy debit, notional plus fee, fits in post-sell cash.

   Report these stable blocker codes when they apply:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as the rotation buy, has `decision === "block"`

   Do not call `recordRiskEngineDecisionEvent` from the helper. Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor that shared allocation helper so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: skip minimum-hold, friction, margin, and age-hysteresis gating.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible, attach `rotation_guard`, and set `would_block` when enforce mode would have removed the action.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, when the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, and reason codes. Include `evaluated_at` from the injected evaluation time. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Refactor `executeRotation()` for atomic commit so that no sell-side filesystem record is written until the buy leg succeeds.

   **Deferral mechanism**: `executeRotation()` must NOT call `executeSell()` directly. Instead it must replicate the sell-side in-memory mutations inline (deducting quantity, adjusting cash, moving to `closed_trades`, creating the `rotation_out` cooldown entry) and collect all sell-side append payloads — trade record, outcome record, token-risk training event, evidence record — in local variables. Only after the buy leg returns a non-null trade are those payloads flushed to disk via the same append helpers that `executeSell()` uses today. The existing `executeSell()` function and its signature must remain unchanged; it continues to handle hard-risk, Harvest, and manual exits with immediate filesystem writes as before.

   Before executing the sell-side mutations, take a deep snapshot of all mutable portfolio fields: `cash`, `positions`, `closed_trades`, `action_history`, and cooldowns. Recompute buy-leg feasibility with the executor-approved size using the shared allocation helper. If infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` immediately without mutating any state.

   Apply the sell-side in-memory mutations. Attempt the buy. If the buy returns a non-null trade, flush all collected payloads to disk (trade, outcome, token-risk, evidence), commit the cooldown, send the cycle trade email, and return `{ status: "filled", sell_trade, buy_trade }`. Both trades must be non-null on a filled result.

   If the buy returns null after in-memory sell mutations have been applied, restore `cash`, `positions`, `closed_trades`, `action_history`, and cooldowns from the pre-sell snapshot. Do not flush any collected payload. Return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`. The cycle site must not email a null sell trade. No completed rotation may return or persist a sell without its buy.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown only when the rotation fills. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces `opened_at_unavailable` and is not an age block;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no training or evidence record.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact.
- Non-rotation exits remain unaffected.
- No protected path is modified.
```
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

## Round 1

### Draft Before Round

```text
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

## Existing Files

- `pipeline.js` contains `SETTINGS_DEFAULTS`, position scoring, cooldown filtering, `evaluateRotationActions()`, `executeRotation()`, and the cycle rotation call site. `executeSell()` mutates the portfolio and immediately appends trade, outcome, and token-risk training events to the filesystem. `log()` appends to the pipeline log. `buildPositionSizingDecision()` and `evaluateSellActions()` are outside the pure guard path: the former writes a training event, and the latter refreshes prices from the network.
- `scripts/verifyScoutRelaxation.js` covers existing rotation ranking and pairing behavior.
- `scripts/verifyCooldownDecay.js` covers the existing shortened cooldown for `rotation_out`.
- `package.json` defines the repository `check` command and its verification scripts.

## Shared Constraints

- Limit implementation to `pipeline.js`, one new verification script, and `package.json`.
- Keep the total change below 650 lines (the buy-leg feasibility helper and atomic-commit refactor are inherently verbose; do not pad but do not sacrifice correctness for line count).
- Use dependency-free ESM consistent with existing code.
- Use injected timestamps in pure guard logic. `evaluateRotationActions(portfolio, approved, nowMs = Date.now())` must accept an optional third argument so existing callers stay valid and fixtures do not depend on wall-clock timing.
- Do not persist normalized settings back onto the portfolio.
- Verification must not access the network or write portfolio, log, report, state, or training files. The verifier must not call `savePortfolio`, `log`, `executeSell`, `executeRotation`, `evaluateSellActions`, or `buildPositionSizingDecision`. Importing `pipeline.js` may still create the reports directory as it does today.
- Apply minimum-hold and economic-hurdle rules only to rotations. Hard-risk exits must remain unaffected.
- Preserve candidate ordering, best-to-weakest index pairing, and `max_rotations_per_cycle`. A guard rejection drops only that pair. It must not `break` the loop and must not backfill the index with a deeper pair. Keep the existing `break` only for `score_delta < rotation_threshold`, because that threshold is monotonic and later pairs are not.
- Preserve active-cooldown filtering so a token sold through `rotation_out` cannot immediately re-enter.
- Treat malformed timestamps and numeric settings conservatively without throwing.
- The default mode is shadow. Enforcement requires an explicit setting change.
- Read-time normalization: mode is `"off"`, `"shadow"`, or `"enforce"`, otherwise `"shadow"`. A non-finite or negative numeric guard setting falls back to its `SETTINGS_DEFAULTS` value. Do not throw.

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add these defaults to `SETTINGS_DEFAULTS`:

   - `rotation_friction_guard_mode: "shadow"`.
   - `rotation_min_hold_hours: 48`.
   - `rotation_round_trip_cost_bps: 125`.
   - `rotation_margin_bps: 50`.
   - `rotation_score_edge_bps_per_point: 10`.
   - `rotation_hysteresis_bps_per_day: 5`.
   - `rotation_hysteresis_max_bps: 50`.

2. Add and export a pure rotation-guard evaluator. It accepts the held position, replacement candidate, score delta, settings, injected `nowMs`, and buy-leg feasibility. It returns:

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

   Round each basis-point component to 6 decimal places before comparison. `allow` is false when a rule blocks in the active mode. `would_block` is true when enforce mode would drop the pair or the buy leg is infeasible.

3. Calculate age and the economic hurdle as:

   ```text
   held_hours = max(0, (nowMs - opened_at_ms) / 3600000)
   held_days = held_hours / 24

   modeled_edge_bps =
     max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps =
     min(
       rotation_hysteresis_max_bps,
       max(0, held_days) * rotation_hysteresis_bps_per_day
     )

   required_edge_bps =
     rotation_round_trip_cost_bps
     + rotation_margin_bps
     + age_hysteresis_bps
   ```

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. Exact equality passes. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0` and does not emit `friction_hurdle_not_cleared` by itself.

4. Emit `minimum_hold_not_met` when a valid `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable`, leaves `held_hours` null, and must not invent an age or independently block the rotation.

5. Add a pure, exported buy-leg feasibility helper that evaluates a proposed rotation before selling. It must not mutate the portfolio, call the network, call live execution, or record training, evidence, or log events. Build an in-memory post-sell copy:

   - estimate sell quantity from `rotation_sell_fraction` and net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as `executeSell()`;
   - add those net proceeds to cash;
   - reduce the held position by the sold quantity and market value;
   - remove it when the remaining quantity is at most `1e-12` or the remaining market value is below 1, matching `executeSell()`'s close rule;
   - include the simulated sell on the copy's closed trades so risk turnover sees the same post-sell book `executeRotation()` sees today.

   Reuse one exported allocation helper for both this estimate and `executeRotation()`. The allocation is the post-sell form of the current executor formula: risk-approved percent when positive, otherwise `risk_per_trade_pct`, optionally capped by `review.approved_size_pct`, then capped by `max_position_pct`, post-sell cash, expected net proceeds, `position_sizing.max_allocation_usd` when present, and remaining post-sell category headroom. Cap the notional so the paper buy debit, notional plus fee, fits in post-sell cash.

   Report these stable blocker codes when they apply:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as the rotation buy, has `decision === "block"`

   Do not call `recordRiskEngineDecisionEvent` from the helper. Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor that shared allocation helper so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: skip minimum-hold, friction, margin, and age-hysteresis gating.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible, attach `rotation_guard`, and set `would_block` when enforce mode would have removed the action.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, when the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, and reason codes. Include `evaluated_at` from the injected evaluation time. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Refactor `executeRotation()` for atomic commit so that no sell-side filesystem record is written until the buy leg succeeds.

   **Deferral mechanism**: `executeRotation()` must NOT call `executeSell()` directly. Instead it must replicate the sell-side in-memory mutations inline (deducting quantity, adjusting cash, moving to `closed_trades`, creating the `rotation_out` cooldown entry) and collect all sell-side append payloads — trade record, outcome record, token-risk training event, evidence record — in local variables. Only after the buy leg returns a non-null trade are those payloads flushed to disk via the same append helpers that `executeSell()` uses today. The existing `executeSell()` function and its signature must remain unchanged; it continues to handle hard-risk, Harvest, and manual exits with immediate filesystem writes as before.

   Before executing the sell-side mutations, take a deep snapshot of all mutable portfolio fields: `cash`, `positions`, `closed_trades`, `action_history`, and cooldowns. Recompute buy-leg feasibility with the executor-approved size using the shared allocation helper. If infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` immediately without mutating any state.

   Apply the sell-side in-memory mutations. Attempt the buy. If the buy returns a non-null trade, flush all collected payloads to disk (trade, outcome, token-risk, evidence), commit the cooldown, send the cycle trade email, and return `{ status: "filled", sell_trade, buy_trade }`. Both trades must be non-null on a filled result.

   If the buy returns null after in-memory sell mutations have been applied, restore `cash`, `positions`, `closed_trades`, `action_history`, and cooldowns from the pre-sell snapshot. Do not flush any collected payload. Return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`. The cycle site must not email a null sell trade. No completed rotation may return or persist a sell without its buy.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown only when the rotation fills. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces `opened_at_unavailable` and is not an age block;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no training or evidence record.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact.
- Non-rotation exits remain unaffected.
- No protected path is modified.

```

### Reviewer 1: grok-build

Status: revise

Reason: The draft names a cash field the portfolio does not have, drops equity from the rotation allocation, and conflicts with close-only cooldowns, cycle email fields, and paper rollback.

Replacement Spec:

```spec
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
- Keep the total change below 650 lines (the buy-leg feasibility helper and atomic-commit refactor are inherently verbose; do not pad but do not sacrifice correctness for line count).
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

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

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

   `allow` is false only when the active mode omits the pair. `would_block` is true when enforce mode would omit the pair, including when the buy leg is infeasible, regardless of the active mode.

3. Calculate age and the economic hurdle as:

   held_hours = max(0, (nowMs - opened_at_ms) / 3600000) when opened_at parses to a finite opened_at_ms
   held_days = held_hours / 24

   modeled_edge_bps = max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps = min(rotation_hysteresis_max_bps, max(0, held_days) * rotation_hysteresis_bps_per_day)

   required_edge_bps = rotation_round_trip_cost_bps + rotation_margin_bps + age_hysteresis_bps

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0`, sets `held_hours` to null, and still runs this comparison. Unknown age does not emit `friction_hurdle_not_cleared` merely because age is missing; a failed numeric comparison still emits it.

4. Emit `minimum_hold_not_met` when a finite `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A future but finite `opened_at` clamps `held_hours` to 0 and is subject to the minimum hold. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable` and must not invent an age or block the rotation by itself.

5. Add a pure, exported `evaluateRotationBuyFeasibility` helper that evaluates a proposed rotation before selling. It must not mutate the caller's portfolio, call the network, call live execution, or record training, evidence, or log events. It must not call `recordRiskEngineDecisionEvent`. Build an in-memory post-sell copy by applying the same economic mutations as `executeSell()`:

   - estimate the sold quantity from `rotation_sell_fraction` and the net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as the paper branch of `executeSell()`;
   - add those net proceeds to `cash_usd`;
   - reduce quantity, `cost_basis_usd`, and `market_value_usd` by the same fraction rules as `executeSell()`;
   - remove the position when the remaining quantity is at most `1e-12` or the remaining market value is below 1;
   - push the simulated sell onto both `closed_trades` and `action_history` so risk turnover sees the same post-sell book `executeRotation()` sees today;
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

   Return `{ feasible, reason_codes, allocation_usd }`. Report every applicable stable blocker code:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached` when post-sell category headroom is `<= 0`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule, including the trend-overlay and cash-equivalent exclusions in `countThesisPositions()`
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as today's rotation buy (`buildBuyRiskIntent(candidate, allocationUsd, "rotation")`), has `decision === "block"`

   Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor `executeRotation()` onto `resolveRotationAllocationUsd` so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: do not omit a pair for minimum hold, friction, margin, or age hysteresis. Still attach `rotation_guard`. `would_block` still reflects what enforce mode would do.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible. `allow` stays true when the only failures are minimum hold or the friction hurdle. `would_block` is true in that case, with those codes on `diagnostic_reason_codes`.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`. For an omitted pair, `allow` is false and `would_block` is true.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule. For those pairs, `allow` is false and `would_block` is true.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, pass one `nowMs` into `evaluateRotationActions()`. When the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, `reason_codes`, and `diagnostic_reason_codes`. Include `evaluated_at` from that same injected `nowMs`. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Refactor `executeRotation()` for atomic paper commit so that no sell-side filesystem record is written until the buy leg succeeds.

   If `shouldUseLiveExecution(portfolio)` is true, return `{ status: "blocked", reason_codes: ["live_execution_not_supported"], sell_trade: null, buy_trade: null }` without sending a transaction and without mutating the portfolio.

   `executeRotation()` must not call `executeSell()`. Replicate the paper sell-side in-memory mutations inline: deduct quantity, cost basis, and market value; add net proceeds to `cash_usd`; push the sell onto `closed_trades` and `action_history`; delete the position only under `executeSell()`'s close rule. Collect the sell-side append payloads in local variables: trade record, outcome record, token-risk training event, and evidence record. The sell reason stays `rotation_out:${action.reason}`. Create the `rotation_out` cooldown in memory only when the close rule fires, using the existing `setCooldown()` path. Do not create a cooldown for a partial sell that leaves the position open.

   The existing `executeSell()` function and its signature must remain unchanged. It continues to handle hard-risk, Harvest, and manual exits with immediate filesystem writes.

   Before any sell-side mutation, deep-snapshot `cash_usd`, `positions`, `closed_trades`, `action_history`, and `cooldowns`. There is no portfolio field named `cash`. Recompute buy-leg feasibility with the executor review and `position_sizing` through the shared helpers. If infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` immediately without mutating state. A missing held position returns `{ status: "failed", reason_codes: ["position_missing"], sell_trade: null, buy_trade: null }` without mutation. A paper sell that produces a non-positive quantity or a rejected fill returns `{ status: "failed", reason_codes: ["sell_leg_rejected"], sell_trade: null, buy_trade: null }` without mutation.

   Apply the sell-side in-memory mutations. Compute the rotation risk decision and token-risk scan in memory. If the risk decision is `"block"`, restore the snapshot and return `{ status: "blocked", reason_codes: ["risk_decision_block"], sell_trade: null, buy_trade: null }` with no filesystem append. Otherwise attempt the buy. Do not call `recordRiskEngineDecisionEvent` or `recordTokenRiskScanEvent` before `openPosition()` returns.

   If the buy returns a non-null trade, then persist the buy-side risk and token-risk events, flush the collected sell payloads through the same append helpers `executeSell()` uses, externalize sell and buy evidence, and return `{ status: "filled", sell_trade, buy_trade }`. Both trades must be non-null on a filled result. `executeRotation()` does not send email.

   If the buy returns null after in-memory sell mutations, restore `cash_usd`, `positions`, `closed_trades`, `action_history`, and `cooldowns` from the pre-sell snapshot. Do not flush any collected payload and do not record the buy-side risk or token-risk events. Return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`.

   Update the cycle site to the new result shape. Send the existing trade emails only when `status === "blocked"` is not the result and `status === "filled"`: one email for `sell_trade` and one for `buy_trade`. Do not email a blocked or failed result. Do not read `sellTrade` or `buyTrade`. No completed rotation may return or persist a sell without its buy.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown, in memory and on the later portfolio save, only when the rotation fills and the sell closed the position. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Import the exported guard, feasibility helper, allocation helper, and `evaluateRotationActions`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces diagnostic `opened_at_unavailable`, leaves `held_hours` null, and is not an age block;
    - unknown age still emits `friction_hurdle_not_cleared` when rounded edge is below cost plus margin with zero hysteresis;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics and `allow: true`;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the allocation helper applies percent caps to `equityUsd()` rather than treating a percent as USD;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- Rotation allocation matches today's executor math on the post-sell book: equity-based percents, post-sell `cash_usd`, net proceeds, category headroom, and the paper debit cap.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no sell trade, outcome, token-risk, evidence, or buy-side risk record.
- A live-execution portfolio is blocked before any sell is submitted.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact. Partial rotations do not create a cooldown.
- The cycle emails only the sell and buy from a filled result, using `sell_trade` and `buy_trade`.
- Non-rotation exits remain unaffected.
- Only `pipeline.js`, `scripts/verifyRotationFrictionGuard.js`, and the `package.json` check script change.
```

Raw Response:

```text
The draft is the source of truth for this review. I'll check it against the rotation path it names so the verdict is based on contradictions, not style.---STATUS---
status: revise
reason: The draft names a cash field the portfolio does not have, drops equity from the rotation allocation, and conflicts with close-only cooldowns, cycle email fields, and paper rollback.

```spec
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
- Keep the total change below 650 lines (the buy-leg feasibility helper and atomic-commit refactor are inherently verbose; do not pad but do not sacrifice correctness for line count).
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

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

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

   `allow` is false only when the active mode omits the pair. `would_block` is true when enforce mode would omit the pair, including when the buy leg is infeasible, regardless of the active mode.

3. Calculate age and the economic hurdle as:

   held_hours = max(0, (nowMs - opened_at_ms) / 3600000) when opened_at parses to a finite opened_at_ms
   held_days = held_hours / 24

   modeled_edge_bps = max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps = min(rotation_hysteresis_max_bps, max(0, held_days) * rotation_hysteresis_bps_per_day)

   required_edge_bps = rotation_round_trip_cost_bps + rotation_margin_bps + age_hysteresis_bps

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0`, sets `held_hours` to null, and still runs this comparison. Unknown age does not emit `friction_hurdle_not_cleared` merely because age is missing; a failed numeric comparison still emits it.

4. Emit `minimum_hold_not_met` when a finite `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A future but finite `opened_at` clamps `held_hours` to 0 and is subject to the minimum hold. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable` and must not invent an age or block the rotation by itself.

5. Add a pure, exported `evaluateRotationBuyFeasibility` helper that evaluates a proposed rotation before selling. It must not mutate the caller's portfolio, call the network, call live execution, or record training, evidence, or log events. It must not call `recordRiskEngineDecisionEvent`. Build an in-memory post-sell copy by applying the same economic mutations as `executeSell()`:

   - estimate the sold quantity from `rotation_sell_fraction` and the net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as the paper branch of `executeSell()`;
   - add those net proceeds to `cash_usd`;
   - reduce quantity, `cost_basis_usd`, and `market_value_usd` by the same fraction rules as `executeSell()`;
   - remove the position when the remaining quantity is at most `1e-12` or the remaining market value is below 1;
   - push the simulated sell onto both `closed_trades` and `action_history` so risk turnover sees the same post-sell book `executeRotation()` sees today;
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

   Return `{ feasible, reason_codes, allocation_usd }`. Report every applicable stable blocker code:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached` when post-sell category headroom is `<= 0`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule, including the trend-overlay and cash-equivalent exclusions in `countThesisPositions()`
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as today's rotation buy (`buildBuyRiskIntent(candidate, allocationUsd, "rotation")`), has `decision === "block"`

   Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor `executeRotation()` onto `resolveRotationAllocationUsd` so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: do not omit a pair for minimum hold, friction, margin, or age hysteresis. Still attach `rotation_guard`. `would_block` still reflects what enforce mode would do.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible. `allow` stays true when the only failures are minimum hold or the friction hurdle. `would_block` is true in that case, with those codes on `diagnostic_reason_codes`.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`. For an omitted pair, `allow` is false and `would_block` is true.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule. For those pairs, `allow` is false and `would_block` is true.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, pass one `nowMs` into `evaluateRotationActions()`. When the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, `reason_codes`, and `diagnostic_reason_codes`. Include `evaluated_at` from that same injected `nowMs`. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Refactor `executeRotation()` for atomic paper commit so that no sell-side filesystem record is written until the buy leg succeeds.

   If `shouldUseLiveExecution(portfolio)` is true, return `{ status: "blocked", reason_codes: ["live_execution_not_supported"], sell_trade: null, buy_trade: null }` without sending a transaction and without mutating the portfolio.

   `executeRotation()` must not call `executeSell()`. Replicate the paper sell-side in-memory mutations inline: deduct quantity, cost basis, and market value; add net proceeds to `cash_usd`; push the sell onto `closed_trades` and `action_history`; delete the position only under `executeSell()`'s close rule. Collect the sell-side append payloads in local variables: trade record, outcome record, token-risk training event, and evidence record. The sell reason stays `rotation_out:${action.reason}`. Create the `rotation_out` cooldown in memory only when the close rule fires, using the existing `setCooldown()` path. Do not create a cooldown for a partial sell that leaves the position open.

   The existing `executeSell()` function and its signature must remain unchanged. It continues to handle hard-risk, Harvest, and manual exits with immediate filesystem writes.

   Before any sell-side mutation, deep-snapshot `cash_usd`, `positions`, `closed_trades`, `action_history`, and `cooldowns`. There is no portfolio field named `cash`. Recompute buy-leg feasibility with the executor review and `position_sizing` through the shared helpers. If infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` immediately without mutating state. A missing held position returns `{ status: "failed", reason_codes: ["position_missing"], sell_trade: null, buy_trade: null }` without mutation. A paper sell that produces a non-positive quantity or a rejected fill returns `{ status: "failed", reason_codes: ["sell_leg_rejected"], sell_trade: null, buy_trade: null }` without mutation.

   Apply the sell-side in-memory mutations. Compute the rotation risk decision and token-risk scan in memory. If the risk decision is `"block"`, restore the snapshot and return `{ status: "blocked", reason_codes: ["risk_decision_block"], sell_trade: null, buy_trade: null }` with no filesystem append. Otherwise attempt the buy. Do not call `recordRiskEngineDecisionEvent` or `recordTokenRiskScanEvent` before `openPosition()` returns.

   If the buy returns a non-null trade, then persist the buy-side risk and token-risk events, flush the collected sell payloads through the same append helpers `executeSell()` uses, externalize sell and buy evidence, and return `{ status: "filled", sell_trade, buy_trade }`. Both trades must be non-null on a filled result. `executeRotation()` does not send email.

   If the buy returns null after in-memory sell mutations, restore `cash_usd`, `positions`, `closed_trades`, `action_history`, and `cooldowns` from the pre-sell snapshot. Do not flush any collected payload and do not record the buy-side risk or token-risk events. Return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`.

   Update the cycle site to the new result shape. Send the existing trade emails only when `status === "blocked"` is not the result and `status === "filled"`: one email for `sell_trade` and one for `buy_trade`. Do not email a blocked or failed result. Do not read `sellTrade` or `buyTrade`. No completed rotation may return or persist a sell without its buy.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown, in memory and on the later portfolio save, only when the rotation fills and the sell closed the position. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Import the exported guard, feasibility helper, allocation helper, and `evaluateRotationActions`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces diagnostic `opened_at_unavailable`, leaves `held_hours` null, and is not an age block;
    - unknown age still emits `friction_hurdle_not_cleared` when rounded edge is below cost plus margin with zero hysteresis;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics and `allow: true`;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the allocation helper applies percent caps to `equityUsd()` rather than treating a percent as USD;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- Rotation allocation matches today's executor math on the post-sell book: equity-based percents, post-sell `cash_usd`, net proceeds, category headroom, and the paper debit cap.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no sell trade, outcome, token-risk, evidence, or buy-side risk record.
- A live-execution portfolio is blocked before any sell is submitted.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact. Partial rotations do not create a cooldown.
- The cycle emails only the sell and buy from a filled result, using `sell_trade` and `buy_trade`.
- Non-rotation exits remain unaffected.
- Only `pipeline.js`, `scripts/verifyRotationFrictionGuard.js`, and the `package.json` check script change.
```
```

### Reviewer 2: claude

Status: approved

Reason: The spec is detailed, internally consistent, and testable, with clear scope limits, deterministic guard logic, an atomic paper-commit design and thorough verification coverage.

Raw Response:

```text
---STATUS---
status: approved
reason: The spec is detailed, internally consistent, and testable, with clear scope limits, deterministic guard logic, an atomic paper-commit design and thorough verification coverage.
```

### Reviewer 3: codex

Status: approved

Reason: The draft is internally consistent, implementation-ready, and defines verifiable behavior for guard evaluation, buy feasibility, atomic paper rotations, logging, and compatibility.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, implementation-ready, and defines verifiable behavior for guard evaluation, buy feasibility, atomic paper rotations, logging, and compatibility.
```

### Reviewer 4: devin

Status: approved

Reason: Spec is internally consistent, formulas are deterministic, mode behaviors and return shapes are unambiguous, and test coverage is sufficient for the stated acceptance criteria.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, formulas are deterministic, mode behaviors and return shapes are unambiguous, and test coverage is sufficient for the stated acceptance criteria.
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

## Round 1

### Draft Before Round

```text
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
- Keep the total change below 650 lines (the buy-leg feasibility helper and atomic-commit refactor are inherently verbose; do not pad but do not sacrifice correctness for line count).
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

## Phase 1 - Implement and Verify the Rotation Guard

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyRotationFrictionGuard.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=README.md -->
<!-- runner:read=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyCooldownDecay.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

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

   `allow` is false only when the active mode omits the pair. `would_block` is true when enforce mode would omit the pair, including when the buy leg is infeasible, regardless of the active mode.

3. Calculate age and the economic hurdle as:

   held_hours = max(0, (nowMs - opened_at_ms) / 3600000) when opened_at parses to a finite opened_at_ms
   held_days = held_hours / 24

   modeled_edge_bps = max(0, score_delta) * rotation_score_edge_bps_per_point

   age_hysteresis_bps = min(rotation_hysteresis_max_bps, max(0, held_days) * rotation_hysteresis_bps_per_day)

   required_edge_bps = rotation_round_trip_cost_bps + rotation_margin_bps + age_hysteresis_bps

   `held_days` is fractional, not floored. Emit `friction_hurdle_not_cleared` when `modeled_edge_bps < required_edge_bps`. This rule supplements the existing `rotation_threshold` check. Unknown age uses `age_hysteresis_bps = 0`, sets `held_hours` to null, and still runs this comparison. Unknown age does not emit `friction_hurdle_not_cleared` merely because age is missing; a failed numeric comparison still emits it.

4. Emit `minimum_hold_not_met` when a finite `opened_at` is strictly younger than `rotation_min_hold_hours`. Equality passes. A future but finite `opened_at` clamps `held_hours` to 0 and is subject to the minimum hold. A missing or invalid `opened_at` adds diagnostic code `opened_at_unavailable` and must not invent an age or block the rotation by itself.

5. Add a pure, exported `evaluateRotationBuyFeasibility` helper that evaluates a proposed rotation before selling. It must not mutate the caller's portfolio, call the network, call live execution, or record training, evidence, or log events. It must not call `recordRiskEngineDecisionEvent`. Build an in-memory post-sell copy by applying the same economic mutations as `executeSell()`:

   - estimate the sold quantity from `rotation_sell_fraction` and the net proceeds with `buildPaperFillExecution`, using the same price, liquidity, execution data, and fee settings as the paper branch of `executeSell()`;
   - add those net proceeds to `cash_usd`;
   - reduce quantity, `cost_basis_usd`, and `market_value_usd` by the same fraction rules as `executeSell()`;
   - remove the position when the remaining quantity is at most `1e-12` or the remaining market value is below 1;
   - push the simulated sell onto both `closed_trades` and `action_history` so risk turnover sees the same post-sell book `executeRotation()` sees today;
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

   Return `{ feasible, reason_codes, allocation_usd }`. Report every applicable stable blocker code:

   - `missing_or_invalid_price`
   - `category_exposure_cap_reached` when post-sell category headroom is `<= 0`
   - `below_min_trade_usd`
   - `position_slot_unavailable` when the simulated sell does not close the position and the buy would exceed `max_open_positions`
   - `thesis_cap_reached` when the simulated sell does not free a needed thesis slot under `openPosition()`'s thesis-cap rule, including the trend-overlay and cash-equivalent exclusions in `countThesisPositions()`
   - `risk_decision_block` when `evaluateRiskDecision()` on the post-sell copy, with the same intent shape as today's rotation buy (`buildBuyRiskIntent(candidate, allocationUsd, "rotation")`), has `decision === "block"`

   Category headroom and the risk decision must use the simulated post-sell book, not the pre-sell book. A full book must remain rotatable when the sell closes the old position.

6. Refactor `executeRotation()` onto `resolveRotationAllocationUsd` so evaluation and execution do not keep separate formulas. Do not change sizing for ordinary buys or non-rotation sells.

7. Integrate guard evaluation into `evaluateRotationActions()` without changing candidate or position pairing:

   - `"off"`: do not omit a pair for minimum hold, friction, margin, or age hysteresis. Still attach `rotation_guard`. `would_block` still reflects what enforce mode would do.
   - `"shadow"`: retain threshold-qualifying actions whose buy leg is feasible. `allow` stays true when the only failures are minimum hold or the friction hurdle. `would_block` is true in that case, with those codes on `diagnostic_reason_codes`.
   - `"enforce"`: omit actions with `minimum_hold_not_met` or `friction_hurdle_not_cleared`. For an omitted pair, `allow` is false and `would_block` is true.
   - In every mode, omit actions whose buy leg is infeasible. Atomic buy feasibility is a safety invariant, not an optional rollout rule. For those pairs, `allow` is false and `would_block` is true.
   - Attach `rotation_guard` only to returned actions. Do not call `log()` here.

8. At the cycle call site, pass one `nowMs` into `evaluateRotationActions()`. When the normalized mode is `"shadow"`, emit one `rotation_guard_shadow` event through the existing `log()` helper for each returned action that carries `rotation_guard`. Include source and destination symbols, mode, score delta, held hours, modeled edge, required edge, round-trip cost, margin, age hysteresis, `allow`, `would_block`, `reason_codes`, and `diagnostic_reason_codes`. Include `evaluated_at` from that same injected `nowMs`. Do not add a log file, and do not emit these events for `"off"` or `"enforce"`.

9. Refactor `executeRotation()` for atomic paper commit so that no sell-side filesystem record is written until the buy leg succeeds.

   If `shouldUseLiveExecution(portfolio)` is true, return `{ status: "blocked", reason_codes: ["live_execution_not_supported"], sell_trade: null, buy_trade: null }` without sending a transaction and without mutating the portfolio.

   `executeRotation()` must not call `executeSell()`. Replicate the paper sell-side in-memory mutations inline: deduct quantity, cost basis, and market value; add net proceeds to `cash_usd`; push the sell onto `closed_trades` and `action_history`; delete the position only under `executeSell()`'s close rule. Collect the sell-side append payloads in local variables: trade record, outcome record, token-risk training event, and evidence record. The sell reason stays `rotation_out:${action.reason}`. Create the `rotation_out` cooldown in memory only when the close rule fires, using the existing `setCooldown()` path. Do not create a cooldown for a partial sell that leaves the position open.

   The existing `executeSell()` function and its signature must remain unchanged. It continues to handle hard-risk, Harvest, and manual exits with immediate filesystem writes.

   Before any sell-side mutation, deep-snapshot `cash_usd`, `positions`, `closed_trades`, `action_history`, and `cooldowns`. There is no portfolio field named `cash`. Recompute buy-leg feasibility with the executor review and `position_sizing` through the shared helpers. If infeasible, return `{ status: "blocked", reason_codes, sell_trade: null, buy_trade: null }` immediately without mutating state. A missing held position returns `{ status: "failed", reason_codes: ["position_missing"], sell_trade: null, buy_trade: null }` without mutation. A paper sell that produces a non-positive quantity or a rejected fill returns `{ status: "failed", reason_codes: ["sell_leg_rejected"], sell_trade: null, buy_trade: null }` without mutation.

   Apply the sell-side in-memory mutations. Compute the rotation risk decision and token-risk scan in memory. If the risk decision is `"block"`, restore the snapshot and return `{ status: "blocked", reason_codes: ["risk_decision_block"], sell_trade: null, buy_trade: null }` with no filesystem append. Otherwise attempt the buy. Do not call `recordRiskEngineDecisionEvent` or `recordTokenRiskScanEvent` before `openPosition()` returns.

   If the buy returns a non-null trade, then persist the buy-side risk and token-risk events, flush the collected sell payloads through the same append helpers `executeSell()` uses, externalize sell and buy evidence, and return `{ status: "filled", sell_trade, buy_trade }`. Both trades must be non-null on a filled result. `executeRotation()` does not send email.

   If the buy returns null after in-memory sell mutations, restore `cash_usd`, `positions`, `closed_trades`, `action_history`, and `cooldowns` from the pre-sell snapshot. Do not flush any collected payload and do not record the buy-side risk or token-risk events. Return `{ status: "failed", reason_codes: ["buy_leg_failed_after_sell"], sell_trade: null, buy_trade: null }`.

   Update the cycle site to the new result shape. Send the existing trade emails only when `status === "blocked"` is not the result and `status === "filled"`: one email for `sell_trade` and one for `buy_trade`. Do not email a blocked or failed result. Do not read `sellTrade` or `buyTrade`. No completed rotation may return or persist a sell without its buy.

10. Keep existing `rotation_out` cooldown creation and case-insensitive cooldown filtering intact as re-entry hysteresis. Commit that cooldown, in memory and on the later portfolio save, only when the rotation fills and the sell closed the position. Do not weaken or bypass cooldown checks for replacement candidates.

11. Add `scripts/verifyRotationFrictionGuard.js` using `node:assert/strict`. Import the exported guard, feasibility helper, allocation helper, and `evaluateRotationActions`. Cover at least:

    - a two-hour-old position fails the minimum hold;
    - a position older than the minimum still fails when modeled edge does not clear cost plus margin;
    - a sufficiently strong candidate clears the hurdle;
    - increasing held age increases the capped incumbency hurdle, using fractional days;
    - the hysteresis cap is honored;
    - exact equality with the required edge passes;
    - missing or malformed `opened_at` produces diagnostic `opened_at_unavailable`, leaves `held_hours` null, and is not an age block;
    - unknown age still emits `friction_hurdle_not_cleared` when rounded edge is below cost plus margin with zero hysteresis;
    - a category-cap block on the post-sell book makes the buy leg infeasible;
    - an estimated allocation below `min_trade_usd` is infeasible;
    - an invalid candidate price is infeasible;
    - a risk decision of `block` on the post-sell copy is infeasible;
    - a partial rotation that cannot free a position slot is infeasible;
    - a full-book rotation whose sell closes the position is not blocked for slot headroom;
    - `"shadow"` retains an otherwise feasible action while exposing would-block diagnostics and `allow: true`;
    - `"enforce"` removes that same action and still evaluates a later pair that clears the threshold;
    - `"off"` preserves existing threshold behavior for a young position when the buy leg is feasible;
    - buy infeasibility blocks in all modes;
    - active cooldown filtering still prevents immediate re-entry;
    - `evaluateSellActions` does not reference the rotation-guard settings, checked without calling it;
    - the allocation helper applies percent caps to `equityUsd()` rather than treating a percent as USD;
    - the tested path performs no filesystem writes beyond the existing `pipeline.js` import side effect.

12. Add syntax checking and execution of `scripts/verifyRotationFrictionGuard.js` to the existing `package.json` `check` command without removing or reordering any existing checks.

### Acceptance Criteria

- `npm install && npm run check` succeeds.
- Default settings evaluate friction, minimum hold, and hysteresis in shadow mode without suppressing otherwise buy-feasible rotations.
- Enforcement mode blocks rotations below the minimum hold or economic hurdle, without skipping later pairs that still clear `rotation_threshold`.
- Older held positions require a larger candidate advantage, up to the configured cap. Fractional days count, and exact equality passes.
- A category-capped, undersized, invalid-price, risk-blocked, thesis-capped, or slot-infeasible buy leg cannot trigger a sale. Slot and category checks use the simulated post-sell book.
- Rotation allocation matches today's executor math on the post-sell book: equity-based percents, post-sell `cash_usd`, net proceeds, category headroom, and the paper debit cap.
- No successful rotation result contains a sell without its corresponding buy. A rolled-back sell leaves no sell trade, outcome, token-risk, evidence, or buy-side risk record.
- A live-execution portfolio is blocked before any sell is submitted.
- Existing rotation ranking, index pairing, cycle caps, and cooldown behavior remain intact. Partial rotations do not create a cooldown.
- The cycle emails only the sell and buy from a filled result, using `sell_trade` and `buy_trade`.
- Non-rotation exits remain unaffected.
- Only `pipeline.js`, `scripts/verifyRotationFrictionGuard.js`, and the `package.json` check script change.

```

### Reviewer 1: claude

Status: approved

Reason: The spec is complete, internally consistent, scoped to three files, and gives testable rules for the guard, buy-leg feasibility, atomic paper commit, and rollback.

Raw Response:

```text
---STATUS---
status: approved
reason: The spec is complete, internally consistent, scoped to three files, and gives testable rules for the guard, buy-leg feasibility, atomic paper commit, and rollback.
```

### Reviewer 2: codex

Status: approved

Reason: The draft is internally consistent, implementation-ready, and defines deterministic guard behavior, atomic rotation semantics, verification coverage, and scope clearly.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, implementation-ready, and defines deterministic guard behavior, atomic rotation semantics, verification coverage, and scope clearly.
```

### Reviewer 3: devin

Status: approved

Reason: Spec is internally consistent, requirements are unambiguous, constraints are complete, and acceptance criteria are measurable.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, requirements are unambiguous, constraints are complete, and acceptance criteria are measurable.
```

### Reviewer 4: local

Status: approved

Reason: (no reason provided by reviewer)

Raw Response:

```text
---STATUS---
status: approved
```

## Final Outcome

Converged in round 1.
