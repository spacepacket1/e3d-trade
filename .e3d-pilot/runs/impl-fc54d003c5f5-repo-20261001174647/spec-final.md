# MOVER/SURGE Evidence Gate and Disciplined Pyramid-In

## Overview

Close the Scout evidence loophole that lets a MOVER or SURGE story count as independent story support for itself. Then make the existing averaging-in path reachable for held positions on the live Scout and buy path, while preserving deterministic eligibility checks, stop ratchets, realized target history, rotation behavior, and a 24-hour post-add cooldown.

## Goals

- Classify MOVER and SURGE stories as late signals that do not satisfy Scout’s genuine story-evidence requirement.
- Keep thesis, watchlist, STAGING, CLUSTER, legacy stories with no story type, and other non-late story evidence eligible. E3D candidate context stays eligible because the shortlist already records it as a `story` item with no `story_type`.
- Use one canonical late-story-type definition for Scout evidence scoring and Scout story classification.
- Let a non-cooling, non-disqualified held symbol through Scout shortlisting, Scout payload filtering, candidate ranking, and the buy engine.
- Correct the existing averaging-in branch before enabling it.
- Limit successful adds to one per symbol per rolling 24 hours, including enforcement inside `openPosition()` before any portfolio write.
- Keep rotation from targeting a symbol that is already held.
- Add deterministic regression coverage for both changes.

## Non-Goals

- Add new narrative, sentiment, momentum, evidence-source, or scoring systems.
- Change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` or any `SCOUT_FLOW_ONLY_MIN_*` constant.
- Add `candidate` or any other value to `SOURCE_TYPES`.
- Block MOVER or SURGE candidates outright.
- Weaken deterministic buy, fraud-risk, category, cash, minimum-trade, risk-engine, or evidence gates.
- Force-trim positions that appreciated beyond a position-size threshold.
- Change Harvest, governance, reconciliation, execution custody, or sidecar evidence behavior.
- Change `HARVEST_PUMP_EXHAUSTION_TYPES` or infer Harvest story types from labels.
- Add scheduled multi-rung pyramiding or bypass the 24-hour add cooldown.
- Change `isInCooldown()` exact-key semantics or post-sell cooldown durations.
- Change `countNewPositionsSince()`.

## Existing Files

- `scripts/evidencePackets.js` builds, normalizes, scores, and evaluates Scout evidence packets. `SOURCE_TYPES` is `story`, `market_data`, `flow`, `liquidity`, `thesis`, `watchlist`, `token_risk`, `data_quality`, `portfolio`, `performance`, and `manual`. `normalizeSourceType()` drops any other authored source type through `inferSourceType()`.
- `scripts/verifyEvidencePackets.js` contains the executed evidence-packet regression assertions.
- `pipeline.js` builds Scout shortlists and prompts, ranks approved candidates, manages cooldowns, and implements `openPosition()`. It already imports `scripts/evidencePackets.js`. `buildScoutEvidenceShortlist()` records an E3D candidate as `source_type: "story"` with label `e3d_candidate_context` and no `story_type`. Held exclusion on that path comes from `options.heldAddresses`, `options.heldSymbols`, and a `disqualifiedAddresses` set that `runScoutDirect()` currently seeds with held addresses. `normalizePortfolioCooldowns()` already returns a `{ until, reason }` map. `npm run check` already executes `scripts/verifyScoutRelaxation.js`.
- `scripts/verifyPaperExecutionRealism.js` covers paper-fill behavior and must stay green without edits.
- `package.json` defines the repository-wide `npm run check` verification chain. This change does not edit it.

## Shared Constraints

- Keep the implementation within five changed files and well below 1,600 changed lines. The expected files are `scripts/evidencePackets.js`, `scripts/verifyEvidencePackets.js`, `pipeline.js`, and `scripts/verifyScoutRelaxation.js`.
- Preserve all existing deterministic eligibility, risk, allocation, category, and execution checks. Position-count and daily new-position caps continue to apply to new entries only.
- Do not modify protected paths, runtime portfolio state, logs, reports, or secrets. New tests assert in-memory portfolio fields and return values. `openPosition()` may keep its existing training-event append and caught ClickHouse sync; do not add I/O and do not assert on those logs.
- Do not change flow-only threshold constants or their comparison semantics.
- Treat a story with no `story_type` as genuine for backward compatibility.
- Normalize story-type comparisons case-insensitively without changing stored source types and without adding a source type.
- Use the existing `portfolio.cooldowns` entry shape `{ until, reason }` and `isInCooldown()` behavior.
- Do not loosen an existing stop or rewrite a target whose partial was already taken.
- Keep tests deterministic and independent of live APIs, current portfolio data, and wall-clock timing except for bounded timestamp assertions.
- `npm install && npm run check` must pass after every phase.

## Phase 1 - Close the Late-Signal Self-Evidencing Loophole

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyEvidencePackets.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. In `scripts/evidencePackets.js`, export `LATE_SIGNAL_STORY_TYPES` as a `Set` containing exactly `MOVER` and `SURGE`. Callers may read it and must not mutate it.

2. Add one shared helper, `countGenuineStoryEvidence(evidence)`, and apply it only to normalized evidence items. Its rules are:

   - Count `thesis` and `watchlist` items unconditionally.
   - Count `story` items unless the uppercased, trimmed `story_type` is in `LATE_SIGNAL_STORY_TYPES`.
   - Count a `story` item with a missing, null, or blank `story_type` as genuine. This is what keeps legacy stories and the shortlist’s `e3d_candidate_context` item eligible.
   - Do not count any other normalized `source_type`.
   - Do not infer `story_type` from labels such as `story_mover` or `e3d_candidate_context`.
   - Do not add `candidate` to `SOURCE_TYPES`. An authored `source_type` of `candidate` cannot survive normalization, so it is not a genuine-evidence class.

3. On a normalized `story` item only, preserve an authored non-blank `story_type` as a trimmed uppercased string. Include that field in the evidence dedupe identity, the `buildEvidenceId()` input, and the packet digest projection only when it is non-blank. Omit the field for blank story types and for every non-story item, including a non-story item that arrived with a stray `story_type`. Packets whose stories have no `story_type` keep their current ids and digests.

4. In `scoreEvidencePacket()`, set `story_evidence_count` from the shared helper. Flow-only warning, missing-evidence behavior, and the quality term that already multiplies `story_evidence_count` must use this same count. Because Harvest story items do not currently carry `story_type`, they remain genuine and Harvest scores stay unchanged.

5. In `evaluateScoutPacketEligibility()`, derive the genuine count from `packet.evidence` with the same helper. Ignore a pre-filled `packet.story_evidence_count` for this decision so a late-story-inflated count cannot force `flow_only: false`. Use the recomputed count for `flow_only` and for `missing_story_thesis_candidate_or_watchlist_evidence`. Keep the current flow-only definition: the genuine count is zero and at least one evidence item has `source_type` `flow`. A zero genuine count with no flow evidence stays `flow_only: false` and still records `missing_story_thesis_candidate_or_watchlist_evidence`.

6. In `pipeline.js`, import `LATE_SIGNAL_STORY_TYPES` and replace both local `new Set(["MOVER", "SURGE"])` definitions: `lateSignalTypes` in `fetchScoutData()` and `warningSignalTypes` in `buildCognitiveState()`. Assign the shared set itself to the `lateSignalTypes` field `fetchScoutData()` already returns and `buildScoutStoryEvidence()` already reads. Leave `HARVEST_PUMP_EXHAUSTION_TYPES` unchanged.

7. Do not change `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT`, any `SCOUT_FLOW_ONLY_MIN_*` constant, `SOURCE_TYPES`, or threshold comparisons.

8. Extend `scripts/verifyEvidencePackets.js` with deterministic regressions modeled on the historical QNT proposal:

   - Build a Scout packet whose only story item has `story_type: "MOVER"`, alongside flow, liquidity, and data-quality evidence, and with no thesis or watchlist support.
   - Assert its `story_evidence_count` is zero, its warnings include `flow_only_candidate`, and `evaluateScoutPacketEligibility()` returns `flow_only: true`.
   - Cover case-insensitive late-story matching, including `mover` and `SuRgE`.
   - Build otherwise equivalent packets with genuine `STAGING` and `CLUSTER` story evidence and assert their story count is positive and `flow_only` is false.
   - Assert a thesis item alone, a watchlist item alone, and a `story` item with no `story_type` and label `e3d_candidate_context` each make the genuine count positive. When flow evidence is also present, `flow_only` is false.
   - Assert a legacy story that omits `story_type`, and the same story with `story_type` set to `""` or whitespace, stay genuine, omit `story_type` on the normalized item, and produce the same evidence id and packet id.
   - Assert a packet with zero genuine story evidence and no flow evidence still has `flow_only: false` and the missing-story reason.
   - Assert two stories that differ only by a non-blank `story_type` produce different evidence ids, and that the stored type is uppercased.
   - Retain all existing evidence-packet assertions.

### Acceptance Criteria

- `LATE_SIGNAL_STORY_TYPES` is the only MOVER/SURGE set used by Scout evidence scoring and by `fetchScoutData()` / `buildCognitiveState()`. `HARVEST_PUMP_EXHAUSTION_TYPES` and `SOURCE_TYPES` are unchanged.
- MOVER and SURGE cannot self-satisfy the story/thesis/watchlist evidence gate.
- Late-story packets that also have flow evidence are classified as flow-only and remain subject to the existing zero-per-cycle cap.
- A zero genuine count without flow evidence is not classified as flow-only.
- Thesis, watchlist, genuine story, legacy story, and unlabeled `e3d_candidate_context` story evidence retain their prior eligibility.
- Packet ids stay stable for evidence that has no `story_type`, and differ when non-blank story classification differs.
- No flow-only constants or scoring dimensions are introduced or changed.
- `npm install && npm run check` passes.

## Phase 2 - Enable Cooldown-Guarded Pyramid-In

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/verifyScoutRelaxation.js -->
<!-- runner:read=scripts/verifyPaperExecutionRealism.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Correct the existing-position branch of `openPosition()` before making it reachable:

   - Resolve the existing position by a case-insensitive match on `portfolio.positions` keys. Mutate that stored entry. A candidate whose symbol differs only by case must not create a second position key. No case-insensitive match means this call is a new position and uses the candidate symbol as the key, as it does today.
   - Before any portfolio write, match cooldown keys to the stored position key case-insensitively. If any matched key is active under `isInCooldown(portfolio, matchedKey)`, return null immediately. This return happens before `portfolio.cash_usd` is reduced and before a trade is appended to `action_history`. Cash, positions, `action_history`, and `cooldowns` stay unchanged. Do not change `isInCooldown()`.
   - Keep the existing quantity, cost-basis, and average-entry update: add the new quantity and the new cash debit into the stored position, then set `avg_entry_price` from the combined cost basis and combined quantity.
   - Set the updated stop to `Math.max(toNum(existing.stop_price, 0), stopPrice)` so an add cannot loosen a ratcheted stop.
   - Merge `target_1`, `target_2`, and `target_3` individually from `existing.targets` and the new sanitized targets:
     - If `existing.partials_taken[key] === true`, keep `existing.targets[key]` unchanged.
     - Otherwise, when the new sanitized value for that key is a finite number greater than 0, store that value.
     - Otherwise, when the existing value is a finite number greater than 0, keep it.
     - Otherwise store null.
   - A missing `partials_taken` object, or a key that is not strictly `true`, means that target has not been taken.
   - Leave `partials_taken` flags unchanged on an add.
   - Do not add a new position-size cap inside `openPosition()`. The live buy path must still run the existing risk decision, which already blocks a projected position above the maximum position size.

2. Allow held symbols through the live Scout admission path, not only the inner shortlist loop:

   - In `buildScoutEvidenceShortlist()`, ignore `options.heldAddresses` and `options.heldSymbols` even when `runScoutDirect()` still passes them. Continue excluding `options.disqualifiedAddresses` and `data.avoidAddresses`.
   - After the loop resolves a symbol, and before a packet is built, exclude that address when the resolved symbol has an active cooldown. Match cooldown keys case-insensitively, then call `isInCooldown()` with each matched key. An excluded address is absent from `entries`, `shortlist`, and `blocked`.
   - In `runScoutDirect()`, stop seeding `disqualifiedAddresses` with held addresses. Real disqualifier-story addresses stay disqualified.
   - In `buildCognitiveState()`, stop adding held addresses to `disqualifiedAddresses` and stop skipping an address only because it is held. Still skip a held address whose symbol is in an active cooldown, using the same case-insensitive cooldown-key match.
   - Change `filterScoutCandidatesAgainstPortfolio()` so a held candidate is removed only when its symbol is in an active cooldown. Keep every unheld candidate in this function, including a name in a post-sell cooldown. This covers both the call inside `runScoutWithTools()` and the call in `runCycle()`. `rankApprovedCandidates()` continues to drop every cooling symbol.
   - Remove the extra `already_held` drop in the `runScoutWithTools()` quality filter, leaving the cooldown-aware portfolio filter in place.
   - Do not bypass Phase 1 evidence eligibility, the flow-only cap, or any other shortlist check.

3. Update every Scout prompt instruction that currently excludes held tokens:

   - `buildScoutPrompt()` lines that exclude held symbols and list held addresses as excluded addresses.
   - `runScoutWithTools()` `SKIP ALREADY HELD` instruction.
   - `runScoutDirect()` system-prompt rule that excludes already-held symbols and addresses.

   State that Scout may propose an add to a held position only when the symbol is not in the 24-hour add cooldown and only for a genuinely fresh, evidence-backed reason, rather than continued price appreciation alone, and that the proposal receives the same quality bar as a new entry. Keep DISQUALIFIER exclusions mandatory.

4. In `rankApprovedCandidates()`:

   - Remove the unconditional existing-position filter so the buy engine can rank a held symbol.
   - Retain the cooldown filter for every candidate, using the same case-insensitive key match as the shortlist.
   - Preserve score ordering and all downstream deterministic checks.
   - Inside `evaluateRotationActions()`, after ranking, ignore every candidate whose symbol matches an open position case-insensitively. A held symbol cannot become `to_candidate`, and a symbol cannot rotate into itself. Do not restore that exclusion inside `rankApprovedCandidates()`. Rotation continues to honor the cooldown filter through ranking.
   - Export `rankApprovedCandidates`, `evaluateRotationActions`, `evaluateBuyActions`, `buildScoutEvidenceShortlist`, and `filterScoutCandidatesAgainstPortfolio` as test seams. `openPosition` and `SETTINGS_DEFAULTS` are already exported. Export nothing else for this change.

5. In `evaluateBuyActions()`:

   - Remove the function-level returns that currently emit no actions when the thesis cap, the open-position cap, or `max_new_positions_per_day` is already exhausted.
   - A ranked candidate whose symbol case-insensitively matches an open position is an add. Emit it when `max_buys_per_cycle`, cash, `min_trade_usd`, and category headroom allow it, including when the thesis cap and open-position cap are full.
   - Free-slot counts, `remainingSlots`, the thesis cap, the open-position cap, and `max_new_positions_per_day` apply only to candidates that would open a new position. When those new-entry limits are exhausted, skip new entries and keep scanning later ranked candidates for adds. Stop the scan when `buysUsed` reaches `max_buys_per_cycle`.
   - An add consumes one `max_buys_per_cycle` slot and does not consume a new-position slot or the daily new-position cap.
   - Set the add action reason to `pyramid_add`, so `countNewPositionsSince()` does not count it. Do not change `countNewPositionsSince()`.
   - New entries keep their current slot, daily-cap, and `new_position` reason behavior.
   - Do not bypass sizing, the executor, or `evaluateRiskDecision()`.

6. Inside `openPosition()`, after the existing-position update has succeeded and before the function returns the trade:

   - Replace `portfolio.cooldowns` with the result of `normalizePortfolioCooldowns()` so every other symbol’s valid cooldown entry is preserved.
   - Set the cooldown on the stored position key to `{ until, reason: "pyramid_add" }`.
   - `until` is an ISO timestamp 24 hours after the add.
   - Do not set this cooldown for a new position or on any path that returns null.
   - Do not call `setCooldown()`, and do not alter post-sell cooldown duration logic.

7. Add the regression assertions to `scripts/verifyScoutRelaxation.js`. It already runs in `npm run check`, so do not edit `package.json` and do not add another script. The test must:

   - Create a deterministic in-memory portfolio that uses `SETTINGS_DEFAULTS`, with positive cash, one priced position, and equity high enough that category headroom remains. Build candidates with positive prices, explicit targets above the fill, `_score`, and allocation at or above `min_trade_usd`.
   - Call `openPosition()` for the initial entry. Assert no `pyramid_add` cooldown exists afterward.
   - Mark at least one target as taken and ratchet the existing stop above the stop the next candidate would produce. On a different target, delete `partials_taken` or leave that key absent.
   - Call `openPosition()` again with the same symbol in a different case.
   - Assert there is still one position key, and quantity and cost basis increase, and average entry price is recalculated from the combined cost basis and combined quantity.
   - Assert the stored stop is still the pre-add ratcheted stop.
   - Assert the already-taken target keeps its original price, the untaken target with a new positive sanitized price takes that new price, and a missing `partials_taken` flag does not block that update. Assert `partials_taken` flags that were already present stay unchanged.
   - Assert the stored position key has a cooldown whose `until` is within five seconds of 24 hours after the add and whose reason is `pyramid_add`, and that a pre-existing cooldown for a different symbol remains.
   - Attempt a third `openPosition()` call for the same symbol during that cooldown and assert it returns null. Assert quantity, cost basis, average entry, stop, targets, partial flags, cooldowns, cash, and `action_history` length are unchanged.
   - Pass the same symbol to `rankApprovedCandidates()` and assert it is omitted during the cooldown.
   - Assert a held symbol without an active cooldown remains rankable.
   - Assert `evaluateRotationActions()` does not select that held symbol as `to_candidate` even when it has the highest `_score`.
   - Assert `evaluateBuyActions()`, with the book already at `max_open_positions` and the thesis cap full, still emits one add whose reason is `pyramid_add`. Include a second, unheld, higher-scored candidate and assert it is not emitted while those new-entry caps are full.
   - Assert a failed `openPosition()` caused by a non-positive price, and a brand-new position on another symbol, do not create a `pyramid_add` cooldown.
   - Build a `buildScoutEvidenceShortlist()` fixture whose token can clear current eligibility, including genuine non-late story evidence, so a flow-only cap cannot hide the result. Pass `options.heldAddresses` and `options.heldSymbols` containing that token. Assert the held, non-cooling, non-disqualified symbol is in `shortlist`. Assert the same symbol is absent from `entries`, `shortlist`, and `blocked` when its cooldown is active, and again when its address is in `options.disqualifiedAddresses`.
   - Assert `filterScoutCandidatesAgainstPortfolio()` keeps a held symbol that is not in cooldown and drops that same held symbol when its cooldown is active. Assert an unheld symbol stays in the filtered list.

8. Keep existing trailing-stop, target-sanitization, rotation, paper-execution, and sell-cooldown expectations unchanged.

### Acceptance Criteria

- A held symbol can enter Scout’s shortlist, survive portfolio filtering, and reach approved ranking when it is not disqualified or cooling down, including when the caller passed its address and symbol in the held sets.
- Held addresses are not copied into the Scout disqualifier set.
- Held-symbol proposals remain subject to the same evidence, quality, sizing, and risk-engine checks as new entries.
- A full book does not by itself prevent an add, and an add does not consume a new-position slot or the daily new-position cap. A new entry still does.
- Rotation still cannot target an existing position.
- A successful add, including one whose symbol case differs from the stored key, updates that single position’s quantity, cost basis, and average entry price.
- An add never loosens the current stop.
- Completed partial targets retain their historical prices. Untaken targets take a new positive sanitized price and are not replaced by null.
- A cooldown rejection returns null before cash, position, history, or cooldown writes.
- A successful add creates a normalized 24-hour `pyramid_add` cooldown on the stored position key. That cooldown blocks immediate reranking and any direct repeated add, and other cooldown entries remain.
- New entries and failed adds do not create the add cooldown.
- Unheld post-sell cooldowns still fail at `rankApprovedCandidates()`.
- Existing sell cooldown behavior and unrelated trading tests remain unchanged.
- The new assertions run through the existing `scripts/verifyScoutRelaxation.js` check-chain entry. `package.json` is unchanged.
- `npm install && npm run check` passes.
