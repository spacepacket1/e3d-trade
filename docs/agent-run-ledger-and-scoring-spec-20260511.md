# Agent Run Ledger, Candidate Scoring, and Evidence Traceability
## Implementation Spec — May 2026

---

## Context

The pipeline is running in hybrid perception mode (`LLM_TOOL_USE=1`). Each cycle, `buildCognitiveState()` makes 3 targeted API calls, produces a compact ranked candidate list, and passes it to Qwen Scout and Harvest as their primary data layer. Agents can optionally drill down with up to 3 targeted tool calls before answering.

The system works but has no feedback loop. We cannot currently answer:
- Did Scout detect this move before the price moved?
- Which signal types are producing the best outcomes?
- Is the system improving cycle over cycle?

This spec covers the next phase of work in priority order.

---

## Priority Order

1. **Non-tradeable address filter at tool executor** — 10-minute fix, do first
2. **Run ledger** — persistent record of every cycle, candidate, signal, tool call, score, and outcome
3. **Candidate scorecard** — dimensional scoring that makes cognition visible and measurable
4. **Evidence traceability** — restore the signal→decision linkage that was lost in tool-calling mode
5. **Fast/deep mode trigger** — automatic depth escalation based on confidence threshold
6. **Specialized scouts** — DO NOT do until the ledger reveals natural signal specialties

---

## 1. Non-Tradeable Filter at Tool Executor (Quick Fix)

**Problem:** `NONTRADEABLE_RE` filters non-tradeables in `buildCognitiveState()` but not in `executeE3DTool()`. When Qwen drills down on an address it received from a tool result (not the cognitive state), non-tradeables can slip through. We observed USDT (`0xdac17f958d2ee523a2206206994597c13d831ec7`) being passed to `e3d_get_token_info` during a live cycle.

**Fix:** In `executeE3DTool()`, before executing `e3d_get_token_info`, `e3d_get_transactions`, and `e3d_get_address_meta`, check the address against a module-level non-tradeable address set. If matched, return a short JSON string instead of making the API call:

```javascript
const NONTRADEABLE_ADDRESSES = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
]);

// In executeE3DTool, for address-based tools:
if (NONTRADEABLE_ADDRESSES.has(address) || NONTRADEABLE_RE.test(symbol)) {
  return JSON.stringify({ error: "non-tradeable address, skip", address });
}
```

Also log a `tool_blocked_nontradeable` event so we can track how often this fires.

---

## 2. Agent Run Ledger

### 2.1 Purpose

The run ledger is the feedback loop that makes everything else improvable. It records, for every cycle:
- What signals were present
- What candidates were proposed and why
- What decisions were made
- What eventually happened to the price

Without this, there is no way to prove the system detects moves before they happen, and no data to drive improvement.

### 2.2 Storage

Write to `logs/run-ledger.jsonl` — one JSON record per cycle, appended. Same format as `pipeline.jsonl` (newline-delimited JSON). Also expose via a `/api/run-ledger` endpoint on the dashboard server for querying.

Optionally write to ClickHouse `run_ledger` table alongside the existing `training_events` table.

### 2.3 Record Schema

One record per cycle. Written at `cycle_end`.

```json
{
  "ledger_version": "1.0",
  "cycle_id": "uuid",
  "cycle_ts": "ISO8601",
  "pipeline_run_id": "uuid",

  "perception": {
    "mode": "cognitive_state" | "full_recursive",
    "api_calls": 3,
    "e3d_candidates_found": 0,
    "story_signals_found": 12,
    "disqualified_count": 4,
    "cognitive_state_candidates": 2,
    "duration_ms": 1955
  },

  "scout": {
    "tool_rounds": 2,
    "tool_calls": [
      { "tool": "e3d_get_token_info", "address": "0x...", "round": 0, "source": "drill_down" }
    ],
    "prompt_tokens": 5298,
    "completion_tokens": 405,
    "duration_ms": 288320,
    "candidates_raw": 1,
    "candidates_after_quality_gate": 1,
    "candidates": [
      {
        "symbol": "TOKEN",
        "address": "0x...",
        "source": "e3d_candidate" | "multi_signal" | "single_signal" | "drill_down",
        "signal_types": ["E3D_CANDIDATE", "ACCUMULATION"],
        "conviction": 78,
        "confidence": 72,
        "scorecard": { ... },         // see §3
        "evidence_refs": [ ... ],     // see §4
        "why_now": "...",
        "entry_zone": { "low": 0.042, "high": 0.047 },
        "market_at_signal": {
          "price_usd": 0.0042,
          "liquidity_usd": 320000,
          "volume_24h_usd": 850000,
          "market_cap_usd": 4200000,
          "change_30m_pct": 1.1,
          "change_24h_pct": 5.2
        }
      }
    ]
  },

  "harvest": {
    "positions_reviewed": 3,
    "tool_rounds": 2,
    "exits_proposed": 0,
    "actions": { "hold": 2, "monitor": 1, "trim": 0, "exit": 0 }
  },

  "risk": {
    "approved": 1,
    "rejected": 0,
    "rejection_reasons": []
  },

  "execution": {
    "buys": 1,
    "sells": 0,
    "trades": [
      {
        "symbol": "TOKEN",
        "address": "0x...",
        "side": "buy",
        "price_usd": 0.0043,
        "cost_usd": 1500,
        "ts": "ISO8601"
      }
    ]
  },

  "portfolio_snapshot": {
    "cash_usd": 98500,
    "equity_usd": 101200,
    "position_count": 4,
    "unrealized_pnl_usd": 1200
  },

  "macro": {
    "regime": "neutral",
    "new_positions_ok": true,
    "tighten_stops": false,
    "btc_change_24h_pct": 1.2,
    "fear_greed": 54
  },

  "outcomes": {
    "recorded_at": null,           // filled in later by outcome recorder
    "price_1h_pct": null,
    "price_4h_pct": null,
    "price_24h_pct": null,
    "price_7d_pct": null,
    "signal_detected_before_move": null,
    "outcome_label": null          // "win" | "loss" | "neutral" | "pending"
  }
}
```

### 2.4 Outcome Recorder

A separate background process (or scheduled task) that:
1. Scans `run-ledger.jsonl` for records where `outcomes.recorded_at` is null and the trade is older than 1h/4h/24h/7d
2. Fetches current price for each traded address via `e3d_get_token_info`
3. Calculates price change since `market_at_signal.price_usd`
4. Updates the record's `outcomes` fields in place (or appends a separate outcome record keyed by `cycle_id`)
5. Sets `signal_detected_before_move = true` if the signal timestamp preceded a price move > 10% within 4h

This is the data that proves (or disproves) the alpha thesis.

---

## 3. Candidate Scorecard

### 3.1 Purpose

Make Scout's reasoning measurable. Instead of a single `confidence` integer, produce a dimensional score that explains WHY a candidate passed or failed. This is the foundation for the fast/deep confidence trigger and for training data labeling.

### 3.2 Schema

Computed in Node.js from the cognitive state + tool results, attached to each candidate before it goes to the LLM.

```json
{
  "story_signal_score": 0-100,
  "thesis_signal_score": 0-100,
  "liquidity_score": 0-100,
  "momentum_score": 0-100,
  "risk_score": 0-100,
  "multi_signal_bonus": 0-25,
  "e3d_candidate_bonus": 0-50,
  "composite_score": 0-100,
  "decision": "pass" | "watch" | "weak" | "fail",
  "decision_reasons": ["string", ...]
}
```

### 3.3 Scoring Rules

**story_signal_score:**
- No buy signals: 0
- 1 single-signal (STAGING, CLUSTER, etc.): 30
- 1 strong signal (ACCUMULATION, SMART_MONEY): 50
- 1 THESIS signal: 60
- 2+ signals: add 15 per additional signal, cap 100

**thesis_signal_score:**
- No thesis: 0
- Thesis present, conviction < 50: 30
- Conviction 50–65: 55
- Conviction 65–80: 75
- Conviction > 80: 95

**liquidity_score:**
- liquidity_usd < 100k: 0 (hard fail)
- 100k–250k: 40
- 250k–500k: 65
- 500k–1M: 80
- > 1M: 100

**momentum_score:**
- change_30m_pct < 0: 20
- 0–2%: 50
- 2–5%: 70
- 5–10%: 85
- > 10%: 60 (may be late entry, penalise slightly)
- change_7d_pct > 300%: 0 (hard fail — already pumped)

**risk_score (inverted — lower risk = higher score):**
- No disqualifier stories: 100
- Warning-level story (MOVER, SURGE): 60
- Disqualifier-adjacent story: 30
- Hard disqualifier present: 0

**multi_signal_bonus:** +15 if 2 signal types, +25 if 3+

**e3d_candidate_bonus:** +50 if source = `e3d_candidate`

**composite_score:**
```
(story_signal_score × 0.25)
+ (thesis_signal_score × 0.20)
+ (liquidity_score × 0.20)
+ (momentum_score × 0.15)
+ (risk_score × 0.20)
+ multi_signal_bonus
+ e3d_candidate_bonus
```
Capped at 100.

**decision:**
- composite_score < 40 or any hard fail: `"fail"`
- 40–59: `"weak"` (can still proceed but flag)
- 60–74: `"watch"`
- 75+: `"pass"`

### 3.4 Where to Compute It

In `buildCognitiveState()`, after building the candidate pool, compute the scorecard for each candidate and attach it. Include the scorecard in the cognitive state JSON sent to the LLM. The LLM should reference the scorecard when explaining its reasoning.

---

## 4. Evidence Traceability

### 4.1 Problem

In the old evidence-packet path, every candidate had an `evidence_packet_id` and `evidence[]` array containing `evi_...` strings that linked it back to specific source stories. This allowed the system to say "I proposed TOKEN because of story evi_abc123, which was an ACCUMULATION story with score 0.78."

In tool-calling mode (`runScoutWithTools`), this linkage is gone. The LLM produces narrative `evidence[]` strings ("ACCUMULATION story: 12 wallets buying") but there is no machine-readable link back to the source story ID. This means:
- The run ledger cannot record which specific stories drove which decisions
- The outcome recorder cannot close the loop: "story X fired → candidate proposed → price moved +15%"
- Training data cannot be labeled at the story level

### 4.2 Fix

In `buildCognitiveState()`, for each candidate, include the source story IDs in the cognitive state:

```json
{
  "rank": 1,
  "symbol": "TOKEN",
  "address": "0x...",
  "source": "multi_signal",
  "signal_types": ["ACCUMULATION", "SMART_MONEY"],
  "story_ids": ["story_abc123", "story_def456"],
  "conviction": 72,
  ...
}
```

Instruct the LLM in the system prompt to copy `story_ids` from the cognitive state into its output for each candidate it proposes.

In the output validation in `runScoutWithTools`, extract `story_ids` from each proposed candidate and record them in the run ledger.

This restores the signal→decision chain without needing the full evidence-packet machinery.

### 4.3 Story ID Source

Stories from `/stories` have `id` or `story_id` fields. Extract these in `buildCognitiveState()` when building `storySignals`. Already have the story objects — just need to carry the ID through.

---

## 5. Fast/Deep Mode Trigger

**Do not implement until the run ledger has at least 2 weeks of data.** The confidence threshold for escalating to deep mode should be set empirically from ledger data, not guessed.

### 5.1 Design (for reference)

```
buildCognitiveState()
  → compute scorecard for each candidate
  → if max(composite_score) < DEEP_MODE_THRESHOLD (e.g. 60):
      → run fast Scout (no tools, cognitive state only, 1 LLM call)
  → else:
      → run hybrid Scout (cognitive state + up to 3 drill-down calls)
```

Fast mode returns in 1 LLM round (~30–60s). Hybrid mode returns in 1–4 rounds (~60–300s). The trigger saves inference time on cycles where the cognitive state is already conclusive (nothing promising, or one obvious strong candidate).

---

## 6. What NOT to Do Yet

**Do not add specialized scout agents** (memecoin scout, whale scout, DeFi scout, liquidity scout, narrative scout).

Reason: you do not yet know which signal dimensions are producing alpha. The run ledger and scorecard will reveal this. If ACCUMULATION stories consistently outperform THESIS stories, that's when you build a specialized accumulation scout. Building specialization before the data reveals natural splits is premature complexity.

**Do not add more external data sources** (on-chain analytics platforms, alternative data feeds, social sentiment) until the current signal set is producing measurable outcomes in the ledger.

---

## 7. Implementation Order

### Step 1 — Non-tradeable filter (immediate)
- Add `NONTRADEABLE_ADDRESSES` set to `executeE3DTool()`
- Log `tool_blocked_nontradeable` event
- Commit

### Step 2 — Story IDs in cognitive state (small, enables everything else)
- Extract `id || story_id` from each story in `buildCognitiveState()`
- Add `story_ids: string[]` to each candidate in the cognitive state
- Add instruction to system prompt: "copy story_ids from the candidate's cognitive state entry into your output"
- Extract and validate story_ids in `runScoutWithTools()` output processing
- Commit

### Step 3 — Candidate scorecard
- Implement `computeCandidateScorecard(candidate, storySignals)` function
- Call it in `buildCognitiveState()` after building candidate pool
- Attach scorecard to each candidate in the cognitive state JSON
- Update Scout system prompt to reference scorecard in reasoning
- Commit

### Step 4 — Run ledger writer
- Implement `writeRunLedgerEntry(cycleData)` — appends to `logs/run-ledger.jsonl`
- Call at `cycle_end` with all accumulated cycle data
- Add `/api/run-ledger` endpoint to `server.js` (last N entries, filterable by date)
- Add run ledger view to dashboard (table: cycle, candidates, decisions, scores)
- Commit

### Step 5 — Outcome recorder
- Implement `scripts/recordOutcomes.js` — standalone script, run on a cron or manually
- Scans ledger for unresolved outcomes, fetches current prices, writes results back
- Commit

### Step 6 — Fast/deep mode trigger (after 2 weeks of ledger data)
- Set `DEEP_MODE_THRESHOLD` based on empirical scorecard distribution from ledger
- Implement conditional routing in `runScoutWithTools()`
- Commit

---

## 8. Key Questions the Ledger Should Answer

After 4–6 weeks of data:

1. **Alpha window:** What is the median time between signal detection and price move > 10%? If it's > 1h, the system has a real edge. If it's < 15min, signals are lagging.

2. **Signal quality by type:** Which story types (ACCUMULATION, SMART_MONEY, THESIS, STAGING) have the highest win rate at 4h and 24h?

3. **E3D candidate quality:** Do `e3d_candidate` source candidates outperform `multi_signal` and `single_signal` candidates? By how much?

4. **Drill-down value:** On cycles where Qwen used drill-down tool calls, did the extra information improve decision quality (as measured by outcome)?

5. **Scorecard calibration:** Does a composite_score > 75 predict a positive 24h outcome more reliably than composite_score 50–75?

The answers to these questions define what to build next.
