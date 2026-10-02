---
run_id: impl-f07eca2e083b-repo-20261002132341
---

# Negotiation Log

## Round 1

### Draft Before Round

```text
# Re-Admit Capped Flow-Only Scout Entries

## Overview

Permit one thin-evidence MOVER/SURGE-derived `flow_only` candidate per Scout cycle while capping a new position at 1.5% of portfolio equity. Preserve the existing canonical evidence classification and all other risk, liquidity, sizing, and execution controls.

## Goals

- Admit at most one qualifying `flow_only` candidate per cycle.
- Allow missing flow measurements while continuing to reject explicit distribution signals.
- Preserve the three existing liquidity, volume, and market-cap minimums.
- Propagate the canonical `flow_only` decision into buy evaluation.
- Cap new `flow_only` positions at 1.5% of equity.
- Add focused eligibility, admission, propagation, and sizing regressions.

## Non-Goals

- Changing the remaining flow-only liquidity, volume, or market-cap thresholds.
- Removing the backward-compatible buy/sell-ratio export.
- Applying the new cap to existing-position or pyramid-in additions.
- Changing position identity, cooldowns, targets, partials, rotation, exits, reconciliation, governance, sidecar evidence, or other sizing caps.
- Adding evidence types, signals, or a second flow-only classifier.
- Enabling flow-only selection in paths that lack the canonical evidence-packet classification.

## Existing Files

- `scripts/evidencePackets.js` defines flow-only thresholds and canonical packet eligibility.
- `pipeline.js` builds the Scout evidence shortlist, propagates evidence metadata, defines settings, and sizes approved buys.
- `scripts/verifyEvidencePackets.js` covers evidence-packet classification and eligibility.
- `scripts/verifyScoutRelaxation.js` covers shortlist admission and `evaluateBuyActions`.
- `.codex-spec-runner/manifest.tsv` confirms `codex:gpt-5.4` as the most recent successfully executed model.

## Shared Constraints

- Keep the implementation within four changed files and well below 1,600 changed lines.
- Do not modify any protected path or generated/runtime artifact.
- Treat `evaluateScoutPacketEligibility` as the sole authority for deciding `flow_only`; downstream code may only consume its propagated result.
- Preserve every existing deterministic gate and cap. The smallest applicable sizing cap wins.
- Keep `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported for compatibility even though eligibility no longer uses it.
- Do not change `SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD`, `SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD`, or `SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD`.
- Do not change `max_position_pct`, `category_cap_pct`, `min_trade_usd`, risk-approved sizing, or pyramid-in headroom behavior.
- Runtime training-event records may be inspected read-only when tracing metadata, but must never be edited or added to the change.

## Phase 1 - Flow-Only Eligibility and Per-Cycle Admission

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
2. In `evaluateScoutPacketEligibility`, retain the existing canonical `isFlowOnly` computation.
3. Change `flowOnlyPasses` so that:
   - `buy_sell_ratio_1h` is not consulted.
   - A missing or blank `flow_signal` passes the flow-signal condition.
   - Any flow signal containing `distribution` fails.
   - The existing liquidity, 24-hour volume, and market-cap comparisons remain unchanged.
4. Retain the unused `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` export unchanged.
5. Extend `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet: MOVER-only narrative evidence, no thesis/candidate/watchlist support, absent or null DEX flow, liquidity `199244`, volume `134777`, and market cap `887545978`. Assert `flow_only === true`, `flow_only_passes === true`, and eligibility succeeds when all other packet requirements are met.
6. Add regressions proving:
   - `distribution` and `strong_distribution` explicitly fail flow-only eligibility.
   - Missing flow measurements do not represent distribution.
   - Falling below each remaining minimum independently causes failure.
   - The buy/sell ratio no longer changes the result.
7. Extend `scripts/verifyScoutRelaxation.js` with a two-candidate flow-only shortlist fixture. Assert the first qualifying candidate is shortlisted and the second is reported in `blocked` with `flow_only_cap_exceeded`.

### Acceptance Criteria

- Exactly one eligible flow-only packet can enter a cycle shortlist.
- A QNT-shaped packet with no measured DEX flow passes the flow-only thresholds.
- Explicit distribution remains a hard flow-only threshold failure.
- Each of the three safety minimums remains independently enforced at its existing value.
- No new flow-only classifier or evidence source is introduced.
- `npm install && npm run check` passes.

## Phase 2 - Canonical Metadata Propagation and New-Entry Size Cap

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add `flow_only_max_position_pct: 0.015` to `SETTINGS_DEFAULTS` beside `max_position_pct`, with a comment identifying it as the ceiling for a newly opened flow-only position.
2. Trace the existing evidence-shortlist proposal, risk-review, and approval path. Use the already-propagated canonical evidence metadata—such as the `flow_only_candidate` warning produced from the packet—to identify flow-only proposals in `evaluateBuyActions`.
3. If the canonical marker is not currently preserved end-to-end, extend the existing `extractEvidenceMetadata`/`applyEvidenceMetadata` path or compact evidence summary so it is preserved explicitly. Do not recompute flow-only status from stories, setup names, flow measurements, or market values.
4. In `evaluateBuyActions`, when and only when a ranked candidate:
   - resolves to a brand-new position, and
   - carries the canonical flow-only classification,
   
   additionally cap `allocationUsd` at `equity × settings.flow_only_max_position_pct`.
5. Stack the new ceiling with cash, risk-approved sizing, `max_position_pct`, category headroom, and all existing constraints. Continue rejecting allocations below `min_trade_usd`; do not raise a capped allocation to meet the floor.
6. Do not apply the flow-only ceiling when address/symbol identity resolution classifies the action as an existing-position add.
7. Extend `scripts/verifyScoutRelaxation.js` to prove:
   - A flow-only new entry whose approved size exceeds the ceiling is capped exactly at 1.5% of equity.
   - A flow-only new entry already below the ceiling is unchanged.
   - A non-flow-only new entry is unchanged.
   - A flow-only pyramid-in add remains governed by existing add sizing and headroom rules.
   - Canonical evidence metadata survives the tested proposal-to-buy-evaluation path.
   - Other caps can still produce an allocation below the flow-only ceiling.

### Acceptance Criteria

- `SETTINGS_DEFAULTS.flow_only_max_position_pct` equals `0.015`.
- New flow-only positions never exceed the configured percentage of equity.
- The cap is driven exclusively by the evidence-packet classification propagated downstream.
- Non-flow-only entries and all existing-position additions retain their prior sizing behavior.
- Existing risk gates, category limits, cash limits, minimum trade handling, and maximum-position handling remain active.
- `npm install && npm run check` passes.

```

### Reviewer 1: grok-build

Status: revise

Reason: Desk filter still drops re-admitted flow-only names, and the QNT fixture must keep a flow evidence item so canonical isFlowOnly can stay true.

Replacement Spec:

```spec
# Re-Admit Capped Flow-Only Scout Entries

## Overview

Permit one thin-evidence MOVER/SURGE-derived `flow_only` candidate per Scout cycle while capping a new position at 1.5% of portfolio equity. Preserve the existing canonical evidence classification and all other risk, liquidity, sizing, and execution controls.

## Goals

- Admit at most one qualifying `flow_only` candidate per cycle.
- Allow missing flow measurements while continuing to reject explicit distribution signals.
- Preserve the three existing liquidity, volume, and market-cap minimums.
- Let a canonically classified flow-only shortlist candidate survive the Scout desk filter and reach buy evaluation.
- Propagate the canonical `flow_only` decision into buy evaluation.
- Cap new `flow_only` positions at 1.5% of equity.
- Add focused eligibility, admission, desk-filter, propagation, and sizing regressions.

## Non-Goals

- Changing the remaining flow-only liquidity, volume, or market-cap thresholds.
- Removing the backward-compatible buy/sell-ratio export.
- Applying the new cap to existing-position or pyramid-in additions.
- Changing position identity, cooldowns, targets, partials, rotation, exits, reconciliation, governance, sidecar evidence, or other sizing caps.
- Adding evidence types, signals, or a second flow-only classifier.
- Enabling flow-only selection in paths that lack the canonical evidence-packet classification.
- Relaxing desk or buy-gate rules other than the dedicated `flow_only_disabled` drop.

## Existing Files

- `scripts/evidencePackets.js` defines flow-only thresholds and canonical packet eligibility.
- `pipeline.js` builds the Scout evidence shortlist, merges packet warnings onto proposals, filters Scout candidates at the desk, defines settings, and sizes approved buys.
- `scripts/verifyEvidencePackets.js` covers evidence-packet classification and eligibility.
- `scripts/verifyScoutRelaxation.js` covers shortlist admission and `evaluateBuyActions`.
- `.codex-spec-runner/manifest.tsv` confirms `codex:gpt-5.4` as the most recent successfully executed model.

## Shared Constraints

- Keep the implementation within four changed files and well below 1,600 changed lines.
- Do not modify any protected path or generated/runtime artifact.
- Treat `evaluateScoutPacketEligibility` as the sole authority for deciding `flow_only`; downstream code may only consume its propagated result.
- Identify a flow-only proposal exclusively by the canonical packet warning `flow_only_candidate` on `evidence_warnings` or `evidence_summary.warnings`. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not stamp `candidate.flow_only = true` as a live buy-path flag.
- Preserve every existing deterministic gate and cap. The smallest applicable sizing cap wins.
- Keep `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported for compatibility even though eligibility no longer uses it.
- Do not change `SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD`, `SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD`, or `SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD`.
- Do not change `max_position_pct`, `category_cap_pct`, `min_trade_usd`, risk-approved sizing, or pyramid-in headroom behavior.
- Runtime training-event records may be inspected read-only when tracing metadata, but must never be edited or added to the change.

## Phase 1 - Flow-Only Eligibility and Per-Cycle Admission

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
2. In `evaluateScoutPacketEligibility`, retain the existing canonical `isFlowOnly` computation (`genuineStoryEvidenceCount === 0` and at least one evidence item with `source_type === "flow"`).
3. Change `flowOnlyPasses` so that:
   - The existing `isFlowOnly &&` prefix remains.
   - `buy_sell_ratio_1h` is not consulted.
   - A missing, null, or blank `flow_signal` passes the flow-signal condition.
   - Any present flow signal whose cleaned lowercase value contains `distribution` fails.
   - The existing liquidity, 24-hour volume, and market-cap comparisons remain unchanged, including NaN failing each comparison.
4. Retain the unused `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` export unchanged.
5. Extend `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet:
   - MOVER-only narrative evidence and no thesis/candidate/watchlist support, so genuine story-side count is 0.
   - A `source_type: "flow"` evidence item remains present so canonical `isFlowOnly` is true.
   - Eligibility input has absent or null DEX `flow_signal` and `buy_sell_ratio_1h`.
   - Liquidity `199244`, volume `134777`, and market cap `887545978`.
   - Assert `flow_only === true`, `flow_only_passes === true`, and eligibility succeeds when all other packet requirements are met.
6. Add regressions proving:
   - `distribution` and `strong_distribution` explicitly fail flow-only eligibility.
   - Missing flow measurements do not represent distribution.
   - Falling below each remaining minimum independently causes failure.
   - The buy/sell ratio no longer changes the result.
7. Extend `scripts/verifyScoutRelaxation.js` with a two-candidate flow-only shortlist fixture. Both packets must be canonically `flow_only` and otherwise eligible (include flow evidence so classification is true). Assert the first qualifying candidate is shortlisted and the second is reported in `blocked` with `flow_only_cap_exceeded`.

### Acceptance Criteria

- Exactly one eligible flow-only packet can enter a cycle shortlist.
- A QNT-shaped packet with a flow evidence item and no measured DEX flow passes the flow-only thresholds.
- Explicit distribution remains a hard flow-only threshold failure.
- Each of the three safety minimums remains independently enforced at its existing value.
- No new flow-only classifier or evidence source is introduced.
- `npm install && npm run check` passes.

## Phase 2 - Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add `flow_only_max_position_pct: 0.015` to `SETTINGS_DEFAULTS` beside `max_position_pct`, with a comment identifying it as the ceiling for a newly opened flow-only position.
2. Trace the existing evidence-shortlist proposal, desk filter, risk-review, and approval path. Merged shortlist candidates already receive packet warnings as `evidence_warnings` and `evidence_summary.warnings`. Use that `flow_only_candidate` warning to identify flow-only proposals in `evaluateBuyActions`.
3. If the canonical warning is not currently preserved on a tested proposal-to-buy-evaluation path, extend the existing `extractEvidenceMetadata`/`applyEvidenceMetadata` path or compact evidence summary so the warning is preserved. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not add a live `candidate.flow_only` flag.
4. In `filterScoutCandidatesForDesk`, keep the liquidity, late-thin-pump, chasing, and max-candidate rules unchanged. Change only the `flow_only_disabled` branch so a candidate carrying the canonical `flow_only_candidate` warning is not dropped for that reason, including when `setup_type` contains `flow_only`. Continue dropping flow-only-labeled candidates that lack the canonical warning. Export `filterScoutCandidatesForDesk` if the regression needs to call it.
5. In `evaluateBuyActions`, when and only when a ranked candidate:
   - resolves to a brand-new position, and
   - carries the canonical `flow_only_candidate` warning,

   additionally cap `allocationUsd` at `equity × settings.flow_only_max_position_pct`.
6. Stack the new ceiling with cash, risk-approved sizing, `max_position_pct`, category headroom, and all existing constraints. Continue rejecting allocations below `min_trade_usd`; do not raise a capped allocation to meet the floor.
7. Do not apply the flow-only ceiling when address/symbol identity resolution classifies the action as an existing-position add.
8. Extend `scripts/verifyScoutRelaxation.js` to prove:
   - A canonical `flow_only_candidate` proposal survives `filterScoutCandidatesForDesk` even when `setup_type` includes `flow_only`, using values that do not trip late-thin-pump or chase skips.
   - A flow-only-labeled candidate without `flow_only_candidate` is still dropped with `flow_only_disabled`.
   - A flow-only new entry whose approved size exceeds the ceiling is capped exactly at 1.5% of equity.
   - A flow-only new entry already below the ceiling is unchanged.
   - A non-flow-only new entry is unchanged.
   - A flow-only pyramid-in add remains governed by existing add sizing and headroom rules.
   - Canonical evidence metadata survives the tested proposal-to-buy-evaluation path.
   - Other caps can still produce an allocation below the flow-only ceiling.

### Acceptance Criteria

- `SETTINGS_DEFAULTS.flow_only_max_position_pct` equals `0.015`.
- A canonically classified flow-only shortlist candidate is not dropped solely by the desk `flow_only_disabled` rule.
- New flow-only positions never exceed the configured percentage of equity.
- The cap is driven exclusively by the evidence-packet `flow_only_candidate` warning propagated downstream.
- Non-canonical flow-only labels remain desk-disabled.
- Non-flow-only entries and all existing-position additions retain their prior sizing behavior.
- Existing risk gates, category limits, cash limits, minimum trade handling, and maximum-position handling remain active.
- `npm install && npm run check` passes.
```

Raw Response:

```text
I'll review the draft against the codebase so the negotiate-loop verdict is grounded in the actual Scout flow-only path.The spec’s four-file list may miss live gates. I’ll read the eligibility, admission, and buy-sizing paths next.---STATUS---
status: revise
reason: Desk filter still drops re-admitted flow-only names, and the QNT fixture must keep a flow evidence item so canonical isFlowOnly can stay true.

```spec
# Re-Admit Capped Flow-Only Scout Entries

## Overview

Permit one thin-evidence MOVER/SURGE-derived `flow_only` candidate per Scout cycle while capping a new position at 1.5% of portfolio equity. Preserve the existing canonical evidence classification and all other risk, liquidity, sizing, and execution controls.

## Goals

- Admit at most one qualifying `flow_only` candidate per cycle.
- Allow missing flow measurements while continuing to reject explicit distribution signals.
- Preserve the three existing liquidity, volume, and market-cap minimums.
- Let a canonically classified flow-only shortlist candidate survive the Scout desk filter and reach buy evaluation.
- Propagate the canonical `flow_only` decision into buy evaluation.
- Cap new `flow_only` positions at 1.5% of equity.
- Add focused eligibility, admission, desk-filter, propagation, and sizing regressions.

## Non-Goals

- Changing the remaining flow-only liquidity, volume, or market-cap thresholds.
- Removing the backward-compatible buy/sell-ratio export.
- Applying the new cap to existing-position or pyramid-in additions.
- Changing position identity, cooldowns, targets, partials, rotation, exits, reconciliation, governance, sidecar evidence, or other sizing caps.
- Adding evidence types, signals, or a second flow-only classifier.
- Enabling flow-only selection in paths that lack the canonical evidence-packet classification.
- Relaxing desk or buy-gate rules other than the dedicated `flow_only_disabled` drop.

## Existing Files

- `scripts/evidencePackets.js` defines flow-only thresholds and canonical packet eligibility.
- `pipeline.js` builds the Scout evidence shortlist, merges packet warnings onto proposals, filters Scout candidates at the desk, defines settings, and sizes approved buys.
- `scripts/verifyEvidencePackets.js` covers evidence-packet classification and eligibility.
- `scripts/verifyScoutRelaxation.js` covers shortlist admission and `evaluateBuyActions`.
- `.codex-spec-runner/manifest.tsv` confirms `codex:gpt-5.4` as the most recent successfully executed model.

## Shared Constraints

- Keep the implementation within four changed files and well below 1,600 changed lines.
- Do not modify any protected path or generated/runtime artifact.
- Treat `evaluateScoutPacketEligibility` as the sole authority for deciding `flow_only`; downstream code may only consume its propagated result.
- Identify a flow-only proposal exclusively by the canonical packet warning `flow_only_candidate` on `evidence_warnings` or `evidence_summary.warnings`. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not stamp `candidate.flow_only = true` as a live buy-path flag.
- Preserve every existing deterministic gate and cap. The smallest applicable sizing cap wins.
- Keep `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported for compatibility even though eligibility no longer uses it.
- Do not change `SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD`, `SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD`, or `SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD`.
- Do not change `max_position_pct`, `category_cap_pct`, `min_trade_usd`, risk-approved sizing, or pyramid-in headroom behavior.
- Runtime training-event records may be inspected read-only when tracing metadata, but must never be edited or added to the change.

## Phase 1 - Flow-Only Eligibility and Per-Cycle Admission

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
2. In `evaluateScoutPacketEligibility`, retain the existing canonical `isFlowOnly` computation (`genuineStoryEvidenceCount === 0` and at least one evidence item with `source_type === "flow"`).
3. Change `flowOnlyPasses` so that:
   - The existing `isFlowOnly &&` prefix remains.
   - `buy_sell_ratio_1h` is not consulted.
   - A missing, null, or blank `flow_signal` passes the flow-signal condition.
   - Any present flow signal whose cleaned lowercase value contains `distribution` fails.
   - The existing liquidity, 24-hour volume, and market-cap comparisons remain unchanged, including NaN failing each comparison.
4. Retain the unused `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` export unchanged.
5. Extend `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet:
   - MOVER-only narrative evidence and no thesis/candidate/watchlist support, so genuine story-side count is 0.
   - A `source_type: "flow"` evidence item remains present so canonical `isFlowOnly` is true.
   - Eligibility input has absent or null DEX `flow_signal` and `buy_sell_ratio_1h`.
   - Liquidity `199244`, volume `134777`, and market cap `887545978`.
   - Assert `flow_only === true`, `flow_only_passes === true`, and eligibility succeeds when all other packet requirements are met.
6. Add regressions proving:
   - `distribution` and `strong_distribution` explicitly fail flow-only eligibility.
   - Missing flow measurements do not represent distribution.
   - Falling below each remaining minimum independently causes failure.
   - The buy/sell ratio no longer changes the result.
7. Extend `scripts/verifyScoutRelaxation.js` with a two-candidate flow-only shortlist fixture. Both packets must be canonically `flow_only` and otherwise eligible (include flow evidence so classification is true). Assert the first qualifying candidate is shortlisted and the second is reported in `blocked` with `flow_only_cap_exceeded`.

### Acceptance Criteria

- Exactly one eligible flow-only packet can enter a cycle shortlist.
- A QNT-shaped packet with a flow evidence item and no measured DEX flow passes the flow-only thresholds.
- Explicit distribution remains a hard flow-only threshold failure.
- Each of the three safety minimums remains independently enforced at its existing value.
- No new flow-only classifier or evidence source is introduced.
- `npm install && npm run check` passes.

## Phase 2 - Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add `flow_only_max_position_pct: 0.015` to `SETTINGS_DEFAULTS` beside `max_position_pct`, with a comment identifying it as the ceiling for a newly opened flow-only position.
2. Trace the existing evidence-shortlist proposal, desk filter, risk-review, and approval path. Merged shortlist candidates already receive packet warnings as `evidence_warnings` and `evidence_summary.warnings`. Use that `flow_only_candidate` warning to identify flow-only proposals in `evaluateBuyActions`.
3. If the canonical warning is not currently preserved on a tested proposal-to-buy-evaluation path, extend the existing `extractEvidenceMetadata`/`applyEvidenceMetadata` path or compact evidence summary so the warning is preserved. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not add a live `candidate.flow_only` flag.
4. In `filterScoutCandidatesForDesk`, keep the liquidity, late-thin-pump, chasing, and max-candidate rules unchanged. Change only the `flow_only_disabled` branch so a candidate carrying the canonical `flow_only_candidate` warning is not dropped for that reason, including when `setup_type` contains `flow_only`. Continue dropping flow-only-labeled candidates that lack the canonical warning. Export `filterScoutCandidatesForDesk` if the regression needs to call it.
5. In `evaluateBuyActions`, when and only when a ranked candidate:
   - resolves to a brand-new position, and
   - carries the canonical `flow_only_candidate` warning,

   additionally cap `allocationUsd` at `equity × settings.flow_only_max_position_pct`.
6. Stack the new ceiling with cash, risk-approved sizing, `max_position_pct`, category headroom, and all existing constraints. Continue rejecting allocations below `min_trade_usd`; do not raise a capped allocation to meet the floor.
7. Do not apply the flow-only ceiling when address/symbol identity resolution classifies the action as an existing-position add.
8. Extend `scripts/verifyScoutRelaxation.js` to prove:
   - A canonical `flow_only_candidate` proposal survives `filterScoutCandidatesForDesk` even when `setup_type` includes `flow_only`, using values that do not trip late-thin-pump or chase skips.
   - A flow-only-labeled candidate without `flow_only_candidate` is still dropped with `flow_only_disabled`.
   - A flow-only new entry whose approved size exceeds the ceiling is capped exactly at 1.5% of equity.
   - A flow-only new entry already below the ceiling is unchanged.
   - A non-flow-only new entry is unchanged.
   - A flow-only pyramid-in add remains governed by existing add sizing and headroom rules.
   - Canonical evidence metadata survives the tested proposal-to-buy-evaluation path.
   - Other caps can still produce an allocation below the flow-only ceiling.

### Acceptance Criteria

- `SETTINGS_DEFAULTS.flow_only_max_position_pct` equals `0.015`.
- A canonically classified flow-only shortlist candidate is not dropped solely by the desk `flow_only_disabled` rule.
- New flow-only positions never exceed the configured percentage of equity.
- The cap is driven exclusively by the evidence-packet `flow_only_candidate` warning propagated downstream.
- Non-canonical flow-only labels remain desk-disabled.
- Non-flow-only entries and all existing-position additions retain their prior sizing behavior.
- Existing risk gates, category limits, cash limits, minimum trade handling, and maximum-position handling remain active.
- `npm install && npm run check` passes.
```
```

### Reviewer 2: claude

Status: approved

Reason: The spec is scoped, consistent across phases, relies on the canonical packet classification, preserves existing gates and caps, and gives testable acceptance criteria.

Raw Response:

```text
---STATUS---
status: approved
reason: The spec is scoped, consistent across phases, relies on the canonical packet classification, preserves existing gates and caps, and gives testable acceptance criteria.
```

### Reviewer 3: codex

Status: revise

Reason: The draft conflicts by naming evaluateScoutPacketEligibility the sole classifier although packet scoring already classifies flow-only to emit the canonical warning.

Replacement Spec:

```spec
# Re-Admit Capped Flow-Only Scout Entries

## Overview

Permit one thin-evidence MOVER/SURGE-derived `flow_only` candidate per Scout cycle while capping a new position at 1.5% of portfolio equity. Preserve the existing canonical evidence classification and all other risk, liquidity, sizing, and execution controls.

## Goals

- Admit at most one qualifying `flow_only` candidate per cycle.
- Allow missing flow measurements while continuing to reject explicit distribution signals.
- Preserve the three existing liquidity, volume, and market-cap minimums.
- Let a canonically classified flow-only shortlist candidate survive the Scout desk filter and reach buy evaluation.
- Propagate the canonical `flow_only_candidate` packet warning into buy evaluation.
- Cap new `flow_only` positions at 1.5% of equity.
- Add focused eligibility, admission, desk-filter, propagation, and sizing regressions.

## Non-Goals

- Changing the remaining flow-only liquidity, volume, or market-cap thresholds.
- Removing the backward-compatible buy/sell-ratio export.
- Applying the new cap to existing-position or pyramid-in additions.
- Changing position identity, cooldowns, targets, partials, rotation, exits, reconciliation, governance, sidecar evidence, or other sizing caps.
- Adding evidence types, signals, or a downstream flow-only classifier.
- Enabling flow-only selection in paths that lack the canonical evidence-packet classification.
- Relaxing desk or buy-gate rules other than the dedicated `flow_only_disabled` drop.

## Existing Files

- `scripts/evidencePackets.js` defines flow-only packet classification, warnings, thresholds, and eligibility.
- `pipeline.js` builds the Scout evidence shortlist, merges packet warnings onto proposals, filters Scout candidates at the desk, defines settings, and sizes approved buys.
- `scripts/verifyEvidencePackets.js` covers evidence-packet classification and eligibility.
- `scripts/verifyScoutRelaxation.js` covers shortlist admission and `evaluateBuyActions`.
- `.codex-spec-runner/manifest.tsv` confirms `codex:gpt-5.4` as the most recent successfully executed model.

## Shared Constraints

- Keep the implementation within four changed files and well below 1,600 changed lines.
- Do not modify any protected path or generated/runtime artifact.
- Keep flow-only classification inside `scripts/evidencePackets.js`. The existing packet-scoring classification emits the canonical `flow_only_candidate` warning, and `evaluateScoutPacketEligibility` remains authoritative for eligibility. Code outside that module may only consume the propagated warning or eligibility result and must not independently classify flow-only candidates.
- Identify a flow-only proposal downstream exclusively by the canonical packet warning `flow_only_candidate` on `evidence_warnings` or `evidence_summary.warnings`. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not stamp `candidate.flow_only = true` as a live buy-path flag.
- Preserve every existing deterministic gate and cap. The smallest applicable sizing cap wins.
- Keep `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported for compatibility even though eligibility no longer uses it.
- Do not change `SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD`, `SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD`, or `SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD`.
- Do not change `max_position_pct`, `category_cap_pct`, `min_trade_usd`, risk-approved sizing, or pyramid-in headroom behavior.
- Runtime training-event records may be inspected read-only when tracing metadata, but must never be edited or added to the change.

## Phase 1 - Flow-Only Eligibility and Per-Cycle Admission

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
2. Preserve the existing packet-scoring and eligibility classification rule: genuine story evidence count equals 0 and at least one evidence item has `source_type === "flow"`.
3. Change `flowOnlyPasses` in `evaluateScoutPacketEligibility` so that:
   - The existing `isFlowOnly &&` prefix remains.
   - `buy_sell_ratio_1h` is not consulted.
   - A missing, null, or blank `flow_signal` passes the flow-signal condition.
   - Any present flow signal whose cleaned lowercase value contains `distribution` fails.
   - The existing liquidity, 24-hour volume, and market-cap comparisons remain unchanged, including NaN failing each comparison.
4. Retain the unused `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` export unchanged.
5. Extend `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet:
   - MOVER-only narrative evidence and no thesis/candidate/watchlist support, so genuine story-side count is 0.
   - A `source_type: "flow"` evidence item remains present, making the packet canonically flow-only and producing `flow_only_candidate`.
   - Eligibility input has absent or null DEX `flow_signal` and `buy_sell_ratio_1h`.
   - Liquidity `199244`, volume `134777`, and market cap `887545978`.
   - Assert `flow_only === true`, `flow_only_passes === true`, and eligibility succeeds when all other packet requirements are met.
6. Add regressions proving:
   - `distribution` and `strong_distribution` explicitly fail flow-only eligibility.
   - Missing, null, and blank flow signals do not represent distribution.
   - Falling below each remaining minimum independently causes failure.
   - The buy/sell ratio no longer changes the result.
7. Extend `scripts/verifyScoutRelaxation.js` with a two-candidate flow-only shortlist fixture. Both packets must be canonically flow-only and otherwise eligible, including flow evidence. Ensure the shortlist limit permits both candidates to be evaluated, then assert the first qualifying candidate is shortlisted and the second is reported in `blocked` with `flow_only_cap_exceeded`.

### Acceptance Criteria

- Exactly one eligible flow-only packet can enter a cycle shortlist.
- A QNT-shaped packet with a flow evidence item and no measured DEX flow passes the flow-only thresholds.
- Explicit distribution remains a hard flow-only threshold failure.
- Each of the three safety minimums remains independently enforced at its existing value.
- No downstream flow-only classifier or new evidence source is introduced.
- `npm install && npm run check` passes.

## Phase 2 - Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add `flow_only_max_position_pct: 0.015` to `SETTINGS_DEFAULTS` beside `max_position_pct`, with a comment identifying it as the ceiling for a newly opened flow-only position.
2. Trace the existing evidence-shortlist proposal, desk-filter, risk-review, and approval path. Merged shortlist candidates already receive packet warnings as `evidence_warnings` and `evidence_summary.warnings`. Use the presence of `flow_only_candidate` in either warning location to identify canonical flow-only proposals downstream.
3. If the canonical warning is not currently preserved on the tested proposal-to-buy-evaluation path, extend the existing `extractEvidenceMetadata`/`applyEvidenceMetadata` path or compact evidence summary so the warning is preserved. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not add a live `candidate.flow_only` flag.
4. In `filterScoutCandidatesForDesk`, keep the liquidity, late-thin-pump, chasing, and max-candidate rules unchanged. Change only the `flow_only_disabled` branch so a candidate carrying the canonical `flow_only_candidate` warning is not dropped for that reason, including when `setup_type` contains `flow_only`. Continue dropping flow-only-labeled candidates that lack the canonical warning, and retain `flow_only_disabled` as the logged reason. Export `filterScoutCandidatesForDesk` for direct regression coverage.
5. In `evaluateBuyActions`, when and only when a ranked candidate:
   - resolves to a brand-new position, and
   - carries the canonical `flow_only_candidate` warning,

   additionally cap `allocationUsd` at `equity × settings.flow_only_max_position_pct`.
6. Stack the new ceiling with cash, risk-approved sizing, `max_position_pct`, category headroom, and all existing constraints. Continue rejecting allocations below `min_trade_usd`; do not raise a capped allocation to meet the floor.
7. Do not apply the flow-only ceiling when address/symbol identity resolution classifies the action as an existing-position add.
8. Extend `scripts/verifyScoutRelaxation.js` to prove:
   - A canonical `flow_only_candidate` proposal survives `filterScoutCandidatesForDesk` even when `setup_type` includes `flow_only`, using values that do not trip late-thin-pump or chase skips.
   - A flow-only-labeled candidate without `flow_only_candidate` is omitted by the desk filter while the branch retains the `flow_only_disabled` reason.
   - A flow-only new entry whose approved size exceeds the ceiling is capped exactly at 1.5% of equity.
   - A flow-only new entry already below the ceiling is unchanged.
   - A non-flow-only new entry is unchanged.
   - A flow-only pyramid-in add remains governed by existing add sizing and headroom rules.
   - Canonical evidence metadata survives the tested proposal-to-buy-evaluation path.
   - Other caps can still produce an allocation below the flow-only ceiling.

### Acceptance Criteria

- `SETTINGS_DEFAULTS.flow_only_max_position_pct` equals `0.015`.
- A canonically classified flow-only shortlist candidate is not dropped solely by the desk `flow_only_disabled` rule.
- New flow-only positions never exceed the configured percentage of equity.
- The cap is driven exclusively by the evidence-packet `flow_only_candidate` warning propagated downstream.
- Non-canonical flow-only labels remain desk-disabled.
- Non-flow-only entries and all existing-position additions retain their prior sizing behavior.
- Existing risk gates, category limits, cash limits, minimum trade handling, and maximum-position handling remain active.
- `npm install && npm run check` passes.
```

Raw Response:

```text
---STATUS---
status: revise
reason: The draft conflicts by naming evaluateScoutPacketEligibility the sole classifier although packet scoring already classifies flow-only to emit the canonical warning.
```spec
# Re-Admit Capped Flow-Only Scout Entries

## Overview

Permit one thin-evidence MOVER/SURGE-derived `flow_only` candidate per Scout cycle while capping a new position at 1.5% of portfolio equity. Preserve the existing canonical evidence classification and all other risk, liquidity, sizing, and execution controls.

## Goals

- Admit at most one qualifying `flow_only` candidate per cycle.
- Allow missing flow measurements while continuing to reject explicit distribution signals.
- Preserve the three existing liquidity, volume, and market-cap minimums.
- Let a canonically classified flow-only shortlist candidate survive the Scout desk filter and reach buy evaluation.
- Propagate the canonical `flow_only_candidate` packet warning into buy evaluation.
- Cap new `flow_only` positions at 1.5% of equity.
- Add focused eligibility, admission, desk-filter, propagation, and sizing regressions.

## Non-Goals

- Changing the remaining flow-only liquidity, volume, or market-cap thresholds.
- Removing the backward-compatible buy/sell-ratio export.
- Applying the new cap to existing-position or pyramid-in additions.
- Changing position identity, cooldowns, targets, partials, rotation, exits, reconciliation, governance, sidecar evidence, or other sizing caps.
- Adding evidence types, signals, or a downstream flow-only classifier.
- Enabling flow-only selection in paths that lack the canonical evidence-packet classification.
- Relaxing desk or buy-gate rules other than the dedicated `flow_only_disabled` drop.

## Existing Files

- `scripts/evidencePackets.js` defines flow-only packet classification, warnings, thresholds, and eligibility.
- `pipeline.js` builds the Scout evidence shortlist, merges packet warnings onto proposals, filters Scout candidates at the desk, defines settings, and sizes approved buys.
- `scripts/verifyEvidencePackets.js` covers evidence-packet classification and eligibility.
- `scripts/verifyScoutRelaxation.js` covers shortlist admission and `evaluateBuyActions`.
- `.codex-spec-runner/manifest.tsv` confirms `codex:gpt-5.4` as the most recent successfully executed model.

## Shared Constraints

- Keep the implementation within four changed files and well below 1,600 changed lines.
- Do not modify any protected path or generated/runtime artifact.
- Keep flow-only classification inside `scripts/evidencePackets.js`. The existing packet-scoring classification emits the canonical `flow_only_candidate` warning, and `evaluateScoutPacketEligibility` remains authoritative for eligibility. Code outside that module may only consume the propagated warning or eligibility result and must not independently classify flow-only candidates.
- Identify a flow-only proposal downstream exclusively by the canonical packet warning `flow_only_candidate` on `evidence_warnings` or `evidence_summary.warnings`. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not stamp `candidate.flow_only = true` as a live buy-path flag.
- Preserve every existing deterministic gate and cap. The smallest applicable sizing cap wins.
- Keep `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported for compatibility even though eligibility no longer uses it.
- Do not change `SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD`, `SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD`, or `SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD`.
- Do not change `max_position_pct`, `category_cap_pct`, `min_trade_usd`, risk-approved sizing, or pyramid-in headroom behavior.
- Runtime training-event records may be inspected read-only when tracing metadata, but must never be edited or added to the change.

## Phase 1 - Flow-Only Eligibility and Per-Cycle Admission

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
2. Preserve the existing packet-scoring and eligibility classification rule: genuine story evidence count equals 0 and at least one evidence item has `source_type === "flow"`.
3. Change `flowOnlyPasses` in `evaluateScoutPacketEligibility` so that:
   - The existing `isFlowOnly &&` prefix remains.
   - `buy_sell_ratio_1h` is not consulted.
   - A missing, null, or blank `flow_signal` passes the flow-signal condition.
   - Any present flow signal whose cleaned lowercase value contains `distribution` fails.
   - The existing liquidity, 24-hour volume, and market-cap comparisons remain unchanged, including NaN failing each comparison.
4. Retain the unused `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` export unchanged.
5. Extend `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet:
   - MOVER-only narrative evidence and no thesis/candidate/watchlist support, so genuine story-side count is 0.
   - A `source_type: "flow"` evidence item remains present, making the packet canonically flow-only and producing `flow_only_candidate`.
   - Eligibility input has absent or null DEX `flow_signal` and `buy_sell_ratio_1h`.
   - Liquidity `199244`, volume `134777`, and market cap `887545978`.
   - Assert `flow_only === true`, `flow_only_passes === true`, and eligibility succeeds when all other packet requirements are met.
6. Add regressions proving:
   - `distribution` and `strong_distribution` explicitly fail flow-only eligibility.
   - Missing, null, and blank flow signals do not represent distribution.
   - Falling below each remaining minimum independently causes failure.
   - The buy/sell ratio no longer changes the result.
7. Extend `scripts/verifyScoutRelaxation.js` with a two-candidate flow-only shortlist fixture. Both packets must be canonically flow-only and otherwise eligible, including flow evidence. Ensure the shortlist limit permits both candidates to be evaluated, then assert the first qualifying candidate is shortlisted and the second is reported in `blocked` with `flow_only_cap_exceeded`.

### Acceptance Criteria

- Exactly one eligible flow-only packet can enter a cycle shortlist.
- A QNT-shaped packet with a flow evidence item and no measured DEX flow passes the flow-only thresholds.
- Explicit distribution remains a hard flow-only threshold failure.
- Each of the three safety minimums remains independently enforced at its existing value.
- No downstream flow-only classifier or new evidence source is introduced.
- `npm install && npm run check` passes.

## Phase 2 - Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add `flow_only_max_position_pct: 0.015` to `SETTINGS_DEFAULTS` beside `max_position_pct`, with a comment identifying it as the ceiling for a newly opened flow-only position.
2. Trace the existing evidence-shortlist proposal, desk-filter, risk-review, and approval path. Merged shortlist candidates already receive packet warnings as `evidence_warnings` and `evidence_summary.warnings`. Use the presence of `flow_only_candidate` in either warning location to identify canonical flow-only proposals downstream.
3. If the canonical warning is not currently preserved on the tested proposal-to-buy-evaluation path, extend the existing `extractEvidenceMetadata`/`applyEvidenceMetadata` path or compact evidence summary so the warning is preserved. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not add a live `candidate.flow_only` flag.
4. In `filterScoutCandidatesForDesk`, keep the liquidity, late-thin-pump, chasing, and max-candidate rules unchanged. Change only the `flow_only_disabled` branch so a candidate carrying the canonical `flow_only_candidate` warning is not dropped for that reason, including when `setup_type` contains `flow_only`. Continue dropping flow-only-labeled candidates that lack the canonical warning, and retain `flow_only_disabled` as the logged reason. Export `filterScoutCandidatesForDesk` for direct regression coverage.
5. In `evaluateBuyActions`, when and only when a ranked candidate:
   - resolves to a brand-new position, and
   - carries the canonical `flow_only_candidate` warning,

   additionally cap `allocationUsd` at `equity × settings.flow_only_max_position_pct`.
6. Stack the new ceiling with cash, risk-approved sizing, `max_position_pct`, category headroom, and all existing constraints. Continue rejecting allocations below `min_trade_usd`; do not raise a capped allocation to meet the floor.
7. Do not apply the flow-only ceiling when address/symbol identity resolution classifies the action as an existing-position add.
8. Extend `scripts/verifyScoutRelaxation.js` to prove:
   - A canonical `flow_only_candidate` proposal survives `filterScoutCandidatesForDesk` even when `setup_type` includes `flow_only`, using values that do not trip late-thin-pump or chase skips.
   - A flow-only-labeled candidate without `flow_only_candidate` is omitted by the desk filter while the branch retains the `flow_only_disabled` reason.
   - A flow-only new entry whose approved size exceeds the ceiling is capped exactly at 1.5% of equity.
   - A flow-only new entry already below the ceiling is unchanged.
   - A non-flow-only new entry is unchanged.
   - A flow-only pyramid-in add remains governed by existing add sizing and headroom rules.
   - Canonical evidence metadata survives the tested proposal-to-buy-evaluation path.
   - Other caps can still produce an allocation below the flow-only ceiling.

### Acceptance Criteria

- `SETTINGS_DEFAULTS.flow_only_max_position_pct` equals `0.015`.
- A canonically classified flow-only shortlist candidate is not dropped solely by the desk `flow_only_disabled` rule.
- New flow-only positions never exceed the configured percentage of equity.
- The cap is driven exclusively by the evidence-packet `flow_only_candidate` warning propagated downstream.
- Non-canonical flow-only labels remain desk-disabled.
- Non-flow-only entries and all existing-position additions retain their prior sizing behavior.
- Existing risk gates, category limits, cash limits, minimum trade handling, and maximum-position handling remain active.
- `npm install && npm run check` passes.
```
```

### Reviewer 4: devin

Status: approved

Reason: Spec is internally consistent, requirements map 1-to-1 to acceptance criteria, constraints are unambiguous, and regression coverage is complete for all new and preserved behaviors.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, requirements map 1-to-1 to acceptance criteria, constraints are unambiguous, and regression coverage is complete for all new and preserved behaviors.
```

### Reviewer 5: local

Status: approved

Reason: The draft is clear and meets all the specified requirements without any missing details or contradictions.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is clear and meets all the specified requirements without any missing details or contradictions.
```

Round Result: not converged

At least one reviewer requested revision in round 1.

## Round 2

### Draft Before Round

```text
# Re-Admit Capped Flow-Only Scout Entries

## Overview

Permit one thin-evidence MOVER/SURGE-derived `flow_only` candidate per Scout cycle while capping a new position at 1.5% of portfolio equity. Preserve the existing canonical evidence classification and all other risk, liquidity, sizing, and execution controls.

## Goals

- Admit at most one qualifying `flow_only` candidate per cycle.
- Allow missing flow measurements while continuing to reject explicit distribution signals.
- Preserve the three existing liquidity, volume, and market-cap minimums.
- Let a canonically classified flow-only shortlist candidate survive the Scout desk filter and reach buy evaluation.
- Propagate the canonical `flow_only_candidate` packet warning into buy evaluation.
- Cap new `flow_only` positions at 1.5% of equity.
- Add focused eligibility, admission, desk-filter, propagation, and sizing regressions.

## Non-Goals

- Changing the remaining flow-only liquidity, volume, or market-cap thresholds.
- Removing the backward-compatible buy/sell-ratio export.
- Applying the new cap to existing-position or pyramid-in additions.
- Changing position identity, cooldowns, targets, partials, rotation, exits, reconciliation, governance, sidecar evidence, or other sizing caps.
- Adding evidence types, signals, or a downstream flow-only classifier.
- Enabling flow-only selection in paths that lack the canonical evidence-packet classification.
- Relaxing desk or buy-gate rules other than the dedicated `flow_only_disabled` drop.

## Existing Files

- `scripts/evidencePackets.js` defines flow-only packet classification, warnings, thresholds, and eligibility.
- `pipeline.js` builds the Scout evidence shortlist, merges packet warnings onto proposals, filters Scout candidates at the desk, defines settings, and sizes approved buys.
- `scripts/verifyEvidencePackets.js` covers evidence-packet classification and eligibility.
- `scripts/verifyScoutRelaxation.js` covers shortlist admission and `evaluateBuyActions`.
- `.codex-spec-runner/manifest.tsv` confirms `codex:gpt-5.4` as the most recent successfully executed model.

## Shared Constraints

- Keep the implementation within four changed files and well below 1,600 changed lines.
- Do not modify any protected path or generated/runtime artifact.
- Keep flow-only classification inside `scripts/evidencePackets.js`. The existing packet-scoring classification emits the canonical `flow_only_candidate` warning, and `evaluateScoutPacketEligibility` remains authoritative for eligibility. Code outside that module may only consume the propagated warning or eligibility result and must not independently classify flow-only candidates.
- Identify a flow-only proposal downstream exclusively by the canonical packet warning `flow_only_candidate` on `evidence_warnings` or `evidence_summary.warnings`. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not stamp `candidate.flow_only = true` as a live buy-path flag.
- Preserve every existing deterministic gate and cap. The smallest applicable sizing cap wins.
- Keep `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` exported for compatibility even though eligibility no longer uses it.
- Do not change `SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD`, `SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD`, or `SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD`.
- Do not change `max_position_pct`, `category_cap_pct`, `min_trade_usd`, risk-approved sizing, or pyramid-in headroom behavior.
- Runtime training-event records may be inspected read-only when tracing metadata, but must never be edited or added to the change.

## Phase 1 - Flow-Only Eligibility and Per-Cycle Admission

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` from `0` to `1`.
2. Preserve the existing packet-scoring and eligibility classification rule: genuine story evidence count equals 0 and at least one evidence item has `source_type === "flow"`.
3. Change `flowOnlyPasses` in `evaluateScoutPacketEligibility` so that:
   - The existing `isFlowOnly &&` prefix remains.
   - `buy_sell_ratio_1h` is not consulted.
   - A missing, null, or blank `flow_signal` passes the flow-signal condition.
   - Any present flow signal whose cleaned lowercase value contains `distribution` fails.
   - The existing liquidity, 24-hour volume, and market-cap comparisons remain unchanged, including NaN failing each comparison.
4. Retain the unused `SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H` export unchanged.
5. Extend `scripts/verifyEvidencePackets.js` with a QNT-shaped late-signal packet:
   - MOVER-only narrative evidence and no thesis/candidate/watchlist support, so genuine story-side count is 0.
   - A `source_type: "flow"` evidence item remains present, making the packet canonically flow-only and producing `flow_only_candidate`.
   - Eligibility input has absent or null DEX `flow_signal` and `buy_sell_ratio_1h`.
   - Liquidity `199244`, volume `134777`, and market cap `887545978`.
   - Assert `flow_only === true`, `flow_only_passes === true`, and eligibility succeeds when all other packet requirements are met.
6. Add regressions proving:
   - `distribution` and `strong_distribution` explicitly fail flow-only eligibility.
   - Missing, null, and blank flow signals do not represent distribution.
   - Falling below each remaining minimum independently causes failure.
   - The buy/sell ratio no longer changes the result.
7. Extend `scripts/verifyScoutRelaxation.js` with a two-candidate flow-only shortlist fixture. Both packets must be canonically flow-only and otherwise eligible, including flow evidence. Ensure the shortlist limit permits both candidates to be evaluated, then assert the first qualifying candidate is shortlisted and the second is reported in `blocked` with `flow_only_cap_exceeded`.

### Acceptance Criteria

- Exactly one eligible flow-only packet can enter a cycle shortlist.
- A QNT-shaped packet with a flow evidence item and no measured DEX flow passes the flow-only thresholds.
- Explicit distribution remains a hard flow-only threshold failure.
- Each of the three safety minimums remains independently enforced at its existing value.
- No downstream flow-only classifier or new evidence source is introduced.
- `npm install && npm run check` passes.

## Phase 2 - Canonical Metadata Propagation, Desk Survival, and New-Entry Size Cap

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Add `flow_only_max_position_pct: 0.015` to `SETTINGS_DEFAULTS` beside `max_position_pct`, with a comment identifying it as the ceiling for a newly opened flow-only position.
2. Trace the existing evidence-shortlist proposal, desk-filter, risk-review, and approval path. Merged shortlist candidates already receive packet warnings as `evidence_warnings` and `evidence_summary.warnings`. Use the presence of `flow_only_candidate` in either warning location to identify canonical flow-only proposals downstream.
3. If the canonical warning is not currently preserved on the tested proposal-to-buy-evaluation path, extend the existing `extractEvidenceMetadata`/`applyEvidenceMetadata` path or compact evidence summary so the warning is preserved. Do not recompute flow-only status from stories, setup names, flow measurements, or market values. Do not add a live `candidate.flow_only` flag.
4. In `filterScoutCandidatesForDesk`, keep the liquidity, late-thin-pump, chasing, and max-candidate rules unchanged. Change only the `flow_only_disabled` branch so a candidate carrying the canonical `flow_only_candidate` warning is not dropped for that reason, including when `setup_type` contains `flow_only`. Continue dropping flow-only-labeled candidates that lack the canonical warning, and retain `flow_only_disabled` as the logged reason. Export `filterScoutCandidatesForDesk` for direct regression coverage.
5. In `evaluateBuyActions`, when and only when a ranked candidate:
   - resolves to a brand-new position, and
   - carries the canonical `flow_only_candidate` warning,

   additionally cap `allocationUsd` at `equity × settings.flow_only_max_position_pct`.
6. Stack the new ceiling with cash, risk-approved sizing, `max_position_pct`, category headroom, and all existing constraints. Continue rejecting allocations below `min_trade_usd`; do not raise a capped allocation to meet the floor.
7. Do not apply the flow-only ceiling when address/symbol identity resolution classifies the action as an existing-position add.
8. Extend `scripts/verifyScoutRelaxation.js` to prove:
   - A canonical `flow_only_candidate` proposal survives `filterScoutCandidatesForDesk` even when `setup_type` includes `flow_only`, using values that do not trip late-thin-pump or chase skips.
   - A flow-only-labeled candidate without `flow_only_candidate` is omitted by the desk filter while the branch retains the `flow_only_disabled` reason.
   - A flow-only new entry whose approved size exceeds the ceiling is capped exactly at 1.5% of equity.
   - A flow-only new entry already below the ceiling is unchanged.
   - A non-flow-only new entry is unchanged.
   - A flow-only pyramid-in add remains governed by existing add sizing and headroom rules.
   - Canonical evidence metadata survives the tested proposal-to-buy-evaluation path.
   - Other caps can still produce an allocation below the flow-only ceiling.

### Acceptance Criteria

- `SETTINGS_DEFAULTS.flow_only_max_position_pct` equals `0.015`.
- A canonically classified flow-only shortlist candidate is not dropped solely by the desk `flow_only_disabled` rule.
- New flow-only positions never exceed the configured percentage of equity.
- The cap is driven exclusively by the evidence-packet `flow_only_candidate` warning propagated downstream.
- Non-canonical flow-only labels remain desk-disabled.
- Non-flow-only entries and all existing-position additions retain their prior sizing behavior.
- Existing risk gates, category limits, cash limits, minimum trade handling, and maximum-position handling remain active.
- `npm install && npm run check` passes.

```

### Reviewer 1: grok-build

Status: approved

Reason: The draft matches the live eligibility, shortlist cap, desk filter, warning propagation, and new-entry sizing paths, and its regressions fit the four named files without contradicting `npm run check`.

Raw Response:

```text
I'll review the draft against the code it names so the verdict is based on whether the spec is implementable as written.---STATUS---
status: approved
reason: The draft matches the live eligibility, shortlist cap, desk filter, warning propagation, and new-entry sizing paths, and its regressions fit the four named files without contradicting `npm run check`.
```

### Reviewer 2: claude

Status: approved

Reason: Spec is scoped, internally consistent, preserves canonical classification and existing gates, and has testable acceptance criteria per phase.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is scoped, internally consistent, preserves canonical classification and existing gates, and has testable acceptance criteria per phase.
```

### Reviewer 3: codex

Status: approved

Reason: The draft is internally consistent, implementation-ready, and defines clear canonical classification, propagation, gating, sizing, and regression requirements.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, implementation-ready, and defines clear canonical classification, propagation, gating, sizing, and regression requirements.
```

### Reviewer 4: devin

Status: approved

Reason: Spec is internally consistent, phase sequencing is correct, constraints are non-contradictory, acceptance criteria are verifiable, and file-count bound holds across both phases.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, phase sequencing is correct, constraints are non-contradictory, acceptance criteria are verifiable, and file-count bound holds across both phases.
```

### Reviewer 5: local

Status: approved

Reason: The draft is clear and meets all the specified requirements without any missing details or contradictions.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is clear and meets all the specified requirements without any missing details or contradictions.
```

## Final Outcome

Converged in round 2.
