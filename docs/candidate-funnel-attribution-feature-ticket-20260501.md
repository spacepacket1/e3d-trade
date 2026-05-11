# Candidate Funnel & Attribution — Feature Ticket (2026-05-01)

## 1. Summary

The e3d-agent-trading-floor pipeline is emitting near-zero trades on most cycles despite a steady stream of E3D candidates. Investigation of `pipeline.js` and `logs/pipeline.jsonl` traces this to three classes of failure: (a) an LLM contract-address truncation bug that silently dropped qualified candidates, (b) a self-defeating throttle loop in `buildRegimeSentinelPolicy` that pins the system to 1 buy/cycle at 0.2× allocation after a small unlucky streak, and (c) opaque, per-cycle funnel telemetry that makes it impossible to tell whether discovery, risk, or execution is the bottleneck.

Fix (a) — the address-repair fix — has already landed in `pipeline.js` (search for `scout_candidate_address_repaired`). This ticket covers everything else: the throttle redesign, controlled funnel relaxation, a rollup view of the candidate funnel, per-rule expectancy attribution, and folding slippage/fees into paper P&L.

**Important constraint:** Do **not** loosen the deterministic buy-gate safety floors (liquidity ≥ $100k, market cap ≥ $2M, volume24 ≥ $10k, slippage ≤ 300 bps, fraud_risk ≥ 35). In the cycle this ticket was authored from, those floors correctly rejected zero-liquidity tokens. The bottleneck is *upstream* of those floors.

## 2. Context — what's happening today

Sample cycle: `2026-05-01T07:17`, captured in `logs/pipeline.jsonl`.

- 7 input candidates entered the scout shortlist builder.
- 5 were correctly blocked: 4 for `zero_liquidity_untradeable`, 2 for `flow_only_thresholds_not_met`.
- 2 candidates qualified for the LLM evidence shortlist.
- LLM returned 1 proposal (ASTEROID — liquidity $1.97M, vol $10.6M, mcap $148M, +4.49%/24h, flow=strong_accumulation).
- LLM emitted contract address `0xf280b16ef293d8e534e370794ef26bf3126` (37 chars) instead of the canonical `0xf280b16ef293d8e534e370794ef26bf312694126` (42 chars). The `shortlistMap.get(addr)` lookup at the (pre-fix) line 4168 failed → candidate dropped via `scout_candidate_downgraded: candidate_not_in_evidence_shortlist`. **Already fixed**, but adds Phase 6 telemetry to make recurrence visible.
- Regime sentinel: `recent_performance.closed_trade_count=63, win_rate=25.4%, profit_factor=0.06`. This fires `negative_recent_profit_factor` and `new_buys_throttled_by_recent_losses` in `buildRegimeSentinelPolicy` → `max_buys_per_cycle=1`, `allocation_multiplier=0.2`, plus a `performanceMultiplier=0.65` on sizing in `buildPositionSizingDecision`. Net: a maximum ~$325 trade per cycle on a $96k portfolio. The system cannot sample its way out of the throttle, because the throttle widens on every losing trade.

## 3. Goals

1. Eliminate the self-defeating throttle loop while preserving genuine drawdown protection.
2. Open the scout funnel surgically without lowering safety floors.
3. Provide a single, queryable view of the funnel (`universe → shortlist → LLM → risk → executor → trade`) so future starvation incidents can be diagnosed in seconds.
4. Attribute realized P&L by signal source, story type, risk rule, and exit reason, so we can tell which rules add edge and which destroy it.
5. Make paper P&L honest about slippage and fees so dashboard numbers are not misleading.

## 4. Non-Goals

- **Do not** lower the deterministic buy-gate floors in `deterministicBuyGate` (`pipeline.js` ~line 5281). Those caught real junk this cycle.
- **Do not** convert `fraud_risk_high` or `zero_liquidity_untradeable` from hard rejects to score penalties.
- **Do not** rewrite exit logic in this ticket. Age-based decay in `computePositionScore` may or may not be wrong — that decision needs the per-rule attribution from Phase 5 first, so any exit-logic change is explicitly deferred.
- **Do not** change the deterministic buy-gate's `evidence_count < 2` threshold in this ticket. Phase 3 instead raises the scout output cap upstream.

## 5. Files of interest

Spec-runner: read these before starting.

- `pipeline.js` — single-file pipeline. Key sections by line:
  - `SETTINGS_DEFAULTS` (~78)
  - `buildRegimeSentinelPolicy` (~1259) — the throttle that needs redesign
  - `regimePolicy` (~984) — base regime → policy map
  - `computeRecentClosedTradeMetrics` (~1232) — rolling 24h closed-trade stats
  - `deterministicBuyGate` (~5281) — DO NOT loosen floors here
  - `runScoutDirect` (~3899) — scout LLM driver, contains `validatedCandidates.slice(0, 3)` and `allScoutCandidates.slice(0, 3)`
  - `buildScoutEvidenceShortlist` (~3614) — packet building & flow-only logic
  - `buildPositionSizingDecision` (~5539) — applies `performanceMultiplier`
  - `runRiskForCandidates` (~5358) — calls deterministic gate, records `recordRiskDecisionEvent`
  - `runCycle` (~6940) — orchestrates everything; `evaluateBuyActions` slice + `policy.allocation_multiplier`
  - `recordTradeEvent`, `recordOutcomeEvent` (~778, 790) — close-out events written to `training-events.jsonl`
- `server.js` — Express server that serves the dashboard; this is where new HTTP endpoints land.
- `logs/pipeline.jsonl` — append-only structured log; contains `scout`, `scout_shortlist_blocked`, `scout_candidate_downgraded`, `scout_candidate_address_repaired`, `risk_approved`, `risk_rejected`, `executor_buy`, `market_regime`, `harvest`, `trade`, `outcome` stages.
- `logs/training-events.jsonl` — long-form per-event records, fields `event_type`, `actor`, `details`, `context`. Authoritative source for attribution work.
- `reports/` — daily JSON reports, e.g. `performance-daily-*.json` consumed by `readLatestJsonReport`.

## 6. Phase 1 — Throttle redesign (replaces "negative_recent_profit_factor" lockup)

### 6.1 Description

The current throttle in `buildRegimeSentinelPolicy` triggers on `profit_factor < 0.7 AND realized_pnl < 0` regardless of sample size, then forces `max_buys_per_cycle = 1` and `allocation_multiplier = 0.2`. Combined with the `performanceMultiplier = 0.65` in sizing, the system cannot recover its own statistics. We need a sample-size guard plus a smoother degradation curve.

### 6.2 Requirements

1. In `buildRegimeSentinelPolicy`, before applying the `negative_recent_profit_factor` branch:
   - require `perf24.closed_trade_count >= 10` AND `perf24.realized_pnl_usd <= -0.005 * equity_usd` (i.e. losses ≥ 0.5% of equity in the window) — both must hold, not either.
   - if either condition fails, do not apply the throttle. Add a reason code `throttle_skipped_low_sample` or `throttle_skipped_immaterial_loss` so the decision is visible.
2. Replace the binary `allocation_multiplier = 0.2` with a graduated multiplier:
   - `profit_factor >= 0.7` → 1.0
   - `profit_factor in [0.4, 0.7)` → 0.7
   - `profit_factor in [0.2, 0.4)` → 0.5
   - `profit_factor < 0.2` → 0.3
   - clamp to `[0.3, 1.0]`. Never go below 0.3 from this rule alone (`stop_loss_cluster` and `risk_off` continue to be able to drive it to 0).
3. Replace the `max_buys_per_cycle = 1` clamp with `max(1, base.max_buys_per_cycle - 1)` so the cap softens proportionally instead of pinning to 1.
4. Keep the existing `stop_loss_cluster` (≥2 stops in 24h → `allow_buys=false`) branch. It is correct.
5. Update `performanceMultiplier` in `buildPositionSizingDecision` (~line 5555) to read the same graduated multiplier rather than re-applying its own 0.65. Centralize the policy in `buildRegimeSentinelPolicy`.
6. Add a new `recent_performance_window_hours` setting to `SETTINGS_DEFAULTS` (default 24). Plumb it through `computeRecentClosedTradeMetrics`.

### 6.3 Acceptance Criteria

- With `closed_trade_count = 5` and any profit_factor, `regime_sentinel.reason_codes` does **not** include `negative_recent_profit_factor` — instead it includes `throttle_skipped_low_sample`.
- With `closed_trade_count = 63, profit_factor = 0.06, realized_pnl = -$254` (the actual sample), `allocation_multiplier` is `0.3` (not `0.2`) and `max_buys_per_cycle` is `max(1, base - 1)`.
- A new unit test in `scripts/` (or a small `tests/` file if one exists) covers all four `profit_factor` bands and the low-sample skip.
- No call site outside `buildRegimeSentinelPolicy` and `buildPositionSizingDecision` reads `allocation_multiplier` separately — verify with grep.

## 7. Phase 2 — Cooldown decays by exit reason

### 7.1 Description

`portfolio.cooldowns[symbol]` is set to a flat `cooldown_hours_after_exit = 12` regardless of why a position closed. A target-hit exit and a stop-loss exit are not equivalent signals — re-entry decisions should reflect that.

### 7.2 Requirements

1. Extend `setCooldown(portfolio, symbol)` (~line 5224) to accept a second argument `exitReason` (string).
2. Map exit reasons to cooldown hours:
   - `stop_loss`, `fraud_risk_*`, `liquidity_drain`, `wash_trade`, `momentum_breakdown` → `cooldown_hours_after_exit` (current default 12).
   - `target_hit`, `partial_target`, `rotation_out`, `harvest_take_profit` → `cooldown_hours_after_exit / 4` (3h default).
   - `time_stop`, `thesis_decay`, anything else → `cooldown_hours_after_exit / 2` (6h default).
3. Update the two call sites of `setCooldown` (use grep) to pass the exit reason from the trade close-out.
4. Persist the exit reason alongside the cooldown timestamp so the dashboard can display *why* a symbol is cooled down: change `portfolio.cooldowns[symbol]` from `untilIso` to `{ until: untilIso, reason: exitReason }`. Update `isInCooldown` and `pruneCooldowns` accordingly. Migrate any existing `portfolio.json` shape on load (treat string values as `{ until: <string>, reason: "legacy" }`).

### 7.3 Acceptance Criteria

- A position closed with `target_hit` cools down for 3h, not 12h.
- `portfolio.cooldowns` entries are objects with `until` and `reason`.
- Pre-existing string-form cooldowns load without error and are upgraded in-memory.

## 8. Phase 3 — Scout funnel relaxation (capped, evidence-bounded)

### 8.1 Description

The scout pipeline caps output at 3 candidates in two places (`runScoutDirect`: `validatedCandidates.slice(0, 3)` near line 4283 and `allScoutCandidates.slice(0, 3)` near line 4782 in the fallback path). The downstream deterministic gate filters strictly, so 3-cap typically yields 0–1 approved candidates. Raise the cap, but keep the evidence-shortlist contract intact so we are not feeding the gate junk.

### 8.2 Requirements

1. Replace both hard `slice(0, 3)` calls in `runScoutDirect` with a configurable cap. Add `scout_max_candidates` (default 6) to `SETTINGS_DEFAULTS`.
2. In the FLOW-only entry path (look for `FLOW-ONLY ENTRY` around line 4390), change the per-candidate evidence-ref minimum from 3 to 2 **only when** all of the following hold: `flow_signal === "strong_accumulation"`, `liquidity_usd >= 500_000`, `market_cap_usd >= 5_000_000`. Narrative/thesis-driven candidates remain at the existing minimum of 3 (the `if (validRefs.length < 3)` check around line 4223).
3. Do **not** change the FLOW-only thresholds themselves (`buy_sell_ratio_1h >= 3.5, liq>$150k, vol24>$75k, mcap>$5M`). Those are correct. Only the evidence-ref count is relaxed, and only for the high-confidence flow path above.
4. Do **not** change `deterministicBuyGate`. That is the safety net.
5. Update `SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT` (find it in `pipeline.js`) only if the current value is below 2. Otherwise leave alone.

### 8.3 Acceptance Criteria

- With a synthetic shortlist of 8 evidence-qualified entries, `runScoutDirect` returns up to 6 candidates (not 3).
- A flow-only candidate with 2 valid evidence refs and the high-confidence thresholds met passes the shortlist evidence check.
- A narrative-driven candidate with 2 valid evidence refs is still downgraded with `too_few_valid_evidence_refs`.
- Replaying the 2026-05-01 07:17 cycle produces ≥1 risk-approved candidate (ASTEROID is the expected pass; address-repair fix is already in place to make this work).

## 9. Phase 4 — Funnel rollup endpoint

### 9.1 Description

All the data needed for a funnel diagnosis already exists across `logs/pipeline.jsonl` and `logs/training-events.jsonl`. What is missing is a single rollup that shows, for a window, how many tokens passed each transition and the top reasons for drops.

### 9.2 Requirements

1. Add `GET /funnel?window=24h&cycle_id=<optional>` to `server.js`. Window must accept `1h`, `6h`, `24h`, `7d`. Default `24h`.
2. Aggregate from `logs/pipeline.jsonl` (preferred — already in chronological order with stage names) and fall back to `training-events.jsonl` only for fields not in pipeline.jsonl.
3. Response shape (JSON):
   ```
   {
     "window": "24h",
     "generated_at": "<iso>",
     "transitions": [
       { "from": "universe_seen", "to": "universe_filtered", "count_in": N, "count_out": M, "drop_reasons_top3": [...] },
       { "from": "universe_filtered", "to": "shortlist_built", ... },
       { "from": "shortlist_built", "to": "shortlist_blocked", ... },     // negative space
       { "from": "shortlist_built", "to": "llm_input", ... },
       { "from": "llm_input", "to": "llm_returned", ... },
       { "from": "llm_returned", "to": "address_repaired", ... },         // count of repairs
       { "from": "llm_returned", "to": "risk_input", ... },
       { "from": "risk_input", "to": "risk_approved", ... },
       { "from": "risk_approved", "to": "executor_input", ... },
       { "from": "executor_input", "to": "trade_opened", ... }
     ],
     "totals": { "trades_opened": K, "cycles_observed": C },
     "top_block_reasons": { "shortlist": [...], "risk": [...], "executor": [...] }
   }
   ```
4. `drop_reasons_top3` must be `[{ "reason_code": "...", "count": N }]` sorted descending. Source: the `reasons[]`/`blockers[]` arrays already attached to `scout_shortlist_blocked`, `risk_rejected`, `executor_*` events.
5. Add a `dashboard/` view if there is an existing dashboard pattern to extend (read `dashboard/` first to confirm). If the dashboard is too divergent, ship the endpoint only and leave the visual for a later ticket.

### 9.3 Non-requirements

- No new persistent storage. This must aggregate at request time from existing logs. If query latency exceeds 500ms over 24h, add a per-cycle precomputed file written by `pipeline.js` at the end of `runCycle` (one JSON per cycle in `reports/funnel-<cycle_id>.json`) and read those instead. Do not add a database.

### 9.4 Acceptance Criteria

- `curl localhost:<port>/funnel?window=24h` returns the schema above for the last 24h of `pipeline.jsonl`.
- Replay against the 2026-05-01 07:17 cycle shows `shortlist_built=2, shortlist_blocked=5, llm_returned=1, address_repaired=1, risk_approved=1` (assuming Phase 3 has landed).

## 10. Phase 5 — Per-rule attribution

### 10.1 Description

We can see *which* rules block trades, but not whether those rules are correlated with realized P&L. Without that, every rule looks load-bearing. We need an "expectancy by rule" view.

### 10.2 Requirements

1. For every `risk_rejected` reason code (e.g. `liquidity_below_100k`, `bearish_order_flow`, `confidence_too_low`) and every `harvest_rejected` reason code, find the *closest analogue* trade that *did* complete (same window, same category). Compute realized P&L of those analogues. This is a quasi-counterfactual; it is only directional, but it tells us which rules are likely costing edge.
2. Implementation: the matching can be coarse — bucket by `category`, `liquidity_band` (log10), `mcap_band` (log10), and `flow_signal`. For each rejection bucket, average realized P&L of *opened* trades in the same bucket over the same time window.
3. Expose as `GET /attribution?window=7d`. Response:
   ```
   {
     "window": "7d",
     "by_rule": [
       { "rule": "bearish_order_flow", "rejections": 14, "matched_opened_trades": 8, "avg_realized_pnl_pct": -2.4, "verdict": "rule_helps" },
       { "rule": "confidence_too_low", "rejections": 31, "matched_opened_trades": 22, "avg_realized_pnl_pct": +0.6, "verdict": "rule_might_hurt" }
     ],
     "by_signal_source": [...],
     "by_story_type": [...],
     "by_exit_reason": [...]
   }
   ```
4. `verdict` is informational, not a control signal — `rule_helps` if blocked-bucket avg < opened-bucket avg by more than 1 percentage point, `rule_might_hurt` if opened-bucket avg > 0 and significantly above blocked-bucket avg, otherwise `inconclusive` (low n or noisy).
5. Read source: `training-events.jsonl` for opened+closed trades (look for `event_type: "outcome"` and `event_type: "trade"`) and `pipeline.jsonl` for rejection events. Do not modify these logs' formats.

### 10.3 Acceptance Criteria

- Endpoint returns within 2s for a 7d window on the existing log volume (~180MB training-events.jsonl).
- Manual sanity check: a rule that has zero rejections in the window returns `inconclusive` with `rejections=0`, not an error.
- A short markdown doc in `docs/` (≤1 page) explaining the methodology and its limits, so a reader does not over-trust the verdict column.

## 11. Phase 6 — Address-repair telemetry

### 11.1 Description

The address-repair fix that landed before this ticket logs `scout_candidate_address_repaired` whenever it salvages a candidate. If repairs become frequent, we should know — it indicates the LLM prompt or model quality is degrading, and the right fix is to tighten the prompt rather than rely on repair forever.

### 11.2 Requirements

1. Surface a counter in `evidence_diagnostics` (look for the `evidence_diagnostics` object built in `runScoutDirect`): `address_repairs_in_cycle: N`.
2. In the funnel rollup (Phase 4), surface `address_repaired` as its own transition (already specified there).
3. Add an alarm threshold: if `address_repairs_in_cycle / candidates_returned > 0.3` over the last 24h, emit a single `pipeline_warning` event with code `frequent_address_repairs`. Surface this in the manager report (`buildManagerReport` ~line 6411) as a warning flag.
4. The repair logic itself is *not* in scope for this ticket — already shipped.

### 11.3 Acceptance Criteria

- Cycle log includes `address_repairs_in_cycle` in the `evidence_diagnostics` object.
- Forcing >30% repair rate in a synthetic test produces exactly one `frequent_address_repairs` warning per affected cycle.

## 12. Phase 7 — Execution realism in paper P&L

### 12.1 Description

`deterministicBuyGate` already tracks `slippage_bps`. Paper fills in `buildPaperFillExecution` (~line 5655) and `openPosition` (~line 6096) need to fold slippage and fees into the entry/exit price so realized P&L on the dashboard reflects what would actually have happened on-chain.

### 12.2 Requirements

1. Read or compute `slippage_bps` for both entry and exit from existing data:
   - Entry: from `proposal.execution_data.estimated_slippage_bps` if present, else default 50 bps.
   - Exit: same source, recomputed at exit time. If not available, default 75 bps (exits tend to be worse).
2. Apply slippage to the fill price:
   - Buy: `fill_price = quoted_price * (1 + slippage_bps/10_000)`.
   - Sell: `fill_price = quoted_price * (1 - slippage_bps/10_000)`.
3. Add a fixed fee model: 25 bps round-trip baseline (12.5 bps each side). Add `fee_bps_per_side` to `SETTINGS_DEFAULTS` (default 12.5). Apply as a deduction to the cash side at fill.
4. Record both the *quoted* and *filled* prices on the trade record, plus the slippage and fee components. Field names: `quoted_price`, `fill_price`, `slippage_bps_applied`, `fee_bps_applied`. Existing fields stay intact.
5. Update `recordTradeEvent` to include these so the per-rule attribution (Phase 5) can group on real P&L.
6. Backfill is **not** required — closed historical trades keep their old numbers; new trades use the realistic model.

### 12.3 Acceptance Criteria

- A paper buy at quoted $1.00 with 50 bps slippage and 12.5 bps fee opens at `fill_price = $1.005` and the cash debit reflects the additional fee.
- A round-trip on a flat-priced asset shows a small loss, not zero P&L.
- Existing closed trades in `portfolio.json` are unaffected; only new trades carry the new fields.

## 13. Sequencing and dependencies

- Phases 1, 2, 3 are independent and can land in parallel. Recommend Phase 1 first (largest behavior change, biggest unlock).
- Phase 4 depends on no other phase; it reads existing logs.
- Phase 5 reads outputs of Phases 1–3 but does not depend on them — it can land alongside Phase 4.
- Phase 6 depends on Phase 4 only for the funnel-side surfacing.
- Phase 7 is independent; do it last so attribution (Phase 5) has clean data going forward.

After Phases 1–3 land: run paper for 48h, then look at `/funnel` and `/attribution` before touching anything else. Do not preemptively tune; let the data show what is broken next.

## 14. Acceptance for the whole ticket

The right success target is **not** "more candidates" — that would invite junk through. The targets are:

1. With Phase 1 done: replaying historical cycles from the last 7 days, no cycle ends in `allocation_multiplier <= 0.2` unless `closed_trade_count >= 10` AND `realized_pnl <= -0.5% of equity`.
2. With Phase 3 done: scout-emitted candidates that survive the shortlist reach Risk in ≥95% of cases (the address-repair fix already handles the dominant historical drop reason).
3. With Phase 4 done: a single HTTP call shows the funnel and top block reasons for the last 24h.
4. With Phase 5 done: at least one risk rule is annotated `rule_might_hurt` or `rule_helps` over the trailing 7d, giving operators something to act on.
5. Trade count over 7d rises meaningfully relative to the prior 7d, **without** widening max drawdown beyond 1.5× the prior period.
6. No safety floor in `deterministicBuyGate` is changed.
