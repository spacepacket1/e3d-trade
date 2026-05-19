# Decision Layer API Integration — Feature Ticket (2026-05-19)

## 1. Summary

The E3D platform has shipped Phases 1–4 of the Decision Layer (spec: `e3d_decision_layer_v1_implementation_spec.md`), which adds structured `E3DActions` and `E3DOutcomes` tables to ClickHouse and exposes them through a set of authenticated API endpoints. The trading floor pipeline currently calls `/theses?status=active` and performs its own signal scoring internally. The Decision Layer gives us pre-computed Q_A scores, risk scores, confidence, expected direction, and trigger reasoning — all of which are strictly richer and more authoritative than what the trading app derives today.

This ticket specifies four integration points:

1. **Scout signal source** — replace `/theses` with `/actions` as the primary structured signal, feeding action scores directly into `thesis_signal_score`.
2. **Harvest exit pre-check** — query `/actions?tokenAddress=` for each held position before running the LLM, and fast-path exit when `avoid` or `reduce_exposure_signal` fires at high risk.
3. **Outcome correlation** — store `action_id` on candidates and fetch E3D action outcomes in `recordOutcomes.js` to enrich training events with `thesis_confirmed`.
4. **Dashboard stats** — display Decision Layer summary metrics from `/actions/summary` and `/outcomes/summary`.

**Important constraint:** No changes to the deterministic buy-gate safety floors (liquidity, market cap, slippage, fraud risk). The Decision Layer adds signal quality upstream of those floors; it does not replace them.

---

## 2. Background

### 2.1 What the Decision Layer gives us

The E3D platform now exposes:

| Endpoint | What it provides |
|---|---|
| `GET /actions` | List of open/evaluated actions, filterable by `actionType`, `status`, `minConfidence`, `maxRisk`, `sort` |
| `GET /actions/:actionId` | Single action with full `evidence_json` parsed |
| `GET /actions/summary` | `open_total`, `by_type`, `confirmation_rate_30d`, `mean_outcome_score_30d` |
| `GET /actions/:actionId/outcome` | `price_return`, `liquidity_change_pct`, `outcome_score`, `confirmation_score`, `thesis_confirmed` |
| `GET /thesis/:thesisId/actions` | All actions for a given thesis |
| `GET /outcomes/summary` | Confirmation rates by action type, filterable by date and horizon |

Each `E3DAction` record contains:

```
action_type         — accumulate_signal | watch | avoid | reduce_exposure_signal | ...
token_address       — canonical EVM address
token_symbol
confidence          — 0.0–1.0 (= c_thesis_enhanced, normalized)
risk_score          — 0.0–1.0
action_score        — Q_A(t) = α·C + β·I + γ·K − δ·R − λ·D
expected_horizon    — hours
expected_direction  — bullish | bearish | neutral
trigger_reason      — human-readable explanation
n_supporting        — story count backing the thesis
conviction_velocity — rate of conviction change
status              — open | confirmed | failed | expired | ...
```

### 2.2 What the trading app does today

- **Scout** (`pipeline.js:3594`): fetches `/theses?status=active&limit=25`, uses `entity_address` for token universe enrichment, derives `thesis_signal_score` from a conviction-tier ladder (lines 3072–3075).
- **Harvest**: runs story-type analysis (LIQUIDITY_DRAIN, WASH_TRADE, etc.) to detect exit signals; LLM decides hold/exit/reduce.
- **Outcomes** (`scripts/recordOutcomes.js`): checks ledger entries ≥ 1h old, fetches current price, computes 1h/4h/24h/7d price change, labels win/loss/neutral.
- **Dashboard** (`dashboard/app.js`): displays pipeline stats from local logs.

### 2.3 Why the integration matters

The thesis-tier signal scoring in the pipeline is a coarse approximation. The Decision Layer Q_A score is derived from five components already computed and calibrated by the E3D platform, including structural overlap convergence (`o_total`), evidence quality (`candidate_convergence_score`), and a tuned risk pressure function. Using Q_A directly gives the trading app a signal that has already been through the OTA integrity pipeline — rather than re-deriving a proxy from raw thesis conviction fields.

For exit signals, the harvest LLM has no privileged view of structural on-chain risk. A pre-computed `avoid` action with `risk_score > 0.65` represents the same data the LLM would reason about, but filtered through the full OTA risk model rather than story-type string matching.

---

## 3. Goals

1. Use `action_score` (Q_A) as the authoritative `thesis_signal_score` for action-sourced tokens in the scout.
2. Enrich the scout token universe from `/actions` (accumulate_signal, watch) the same way it is currently enriched from `/theses`.
3. Short-circuit the harvest LLM for clear structural exit signals without removing the LLM's discretion on ambiguous cases.
4. Store `action_id` provenance on candidates so trading outcomes can be correlated with E3D action outcomes in training data.
5. Show Decision Layer health metrics on the dashboard.

## 4. Non-Goals

- Replacing the LLM scout or harvest agents — they get richer context, not a different role.
- Writing anything back to E3D ClickHouse tables — the trading app is a read-only API consumer per the Phase 5 boundary defined in the spec.
- Modifying the deterministic buy-gate safety floors.
- Changing the risk engine, liquidity execution controls, or promotion gates.
- Any live-trading execution — the system remains in paper mode.

---

## 5. Changes Required

### 5.1 Phase A — Scout: `/actions` as primary signal source

**File:** `pipeline.js`

**Function:** `buildScoutIntelUrls()` (around line 329) and `buildScoutTokenUniverse()` (around line 3500)

#### 5.1.1 Fetch the action feed alongside theses

In `buildScoutIntelUrls()`, add the `/actions` URL to the intel fetch list:

```javascript
urls.push(`${E3D_API_BASE_URL}/actions?status=open&actionType=accumulate_signal,paper_buy,watch&sort=action_score_desc&limit=30&maxRisk=0.65&minConfidence=0.40`);
```

This runs in parallel with the existing token, story, and thesis fetches.

In `buildScoutTokenUniverse()`, extract the result alongside `e3dTheses`:

```javascript
const e3dActionsRaw = endpointArray(fetchJson("/actions", {
  status: "open",
  actionType: "accumulate_signal,paper_buy,watch",
  sort: "action_score_desc",
  limit: 30,
  maxRisk: 0.65,
  minConfidence: 0.40
}));
const e3dActions = e3dActionsRaw.filter(a => a?.token_address);
log("scout_e3d_actions", { count: e3dActions.length });
```

Keep the existing `/theses` fetch — both sources are used for enrichment.

#### 5.1.2 Token universe enrichment from actions

Add an action-sourced enrichment loop immediately after the existing `thesisEnrichAdded` loop (around line 3637). Same pattern, different source:

```javascript
let actionEnrichAdded = 0;
for (const action of e3dActions.slice(0, 12)) {
  const addr = cleanAddress(action.token_address || "");
  if (!addr || seen.has(addr)) continue;
  try {
    const rows = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
      dataSource: 1, search: addr, limit: 1
    }));
    const row = rows.find(r => cleanAddress(r.address || r.contract_address || "") === addr) || rows[0];
    if (!row) continue;
    const enriched = mapToken(row);
    if (enriched.address && (enriched.price_usd ?? 0) > 0 && !seen.has(enriched.address) &&
        !nonTradeablePattern.test(enriched.symbol || "")) {
      seen.add(enriched.address);
      // Attach the action reference so it survives into candidate scoring
      enriched._e3d_action = {
        action_id:          action.action_id,
        action_type:        action.action_type,
        action_score:       action.action_score,
        confidence:         action.confidence,
        risk_score:         action.risk_score,
        expected_direction: action.expected_direction,
        expected_horizon:   action.expected_horizon,
        trigger_reason:     action.trigger_reason,
        n_supporting:       action.n_supporting,
      };
      tokenUniverse.push(enriched);
      actionEnrichAdded++;
    }
  } catch (_) {}
}
log("scout_action_enrichment", { checked: Math.min(e3dActions.length, 12), added: actionEnrichAdded });
```

Pass `e3dActions` through the return value alongside `e3dTheses`:

```javascript
return { ..., e3dTheses, e3dActions, ... };
```

#### 5.1.3 Replace thesis_signal_score with action_score for action-sourced tokens

In the candidate scoring section (around line 3055 — `computeCandidateSignalScores`), after `thesis_signal_score` is derived from the conviction ladder, check whether the token has an attached `_e3d_action`:

```javascript
// If this token originated from a Decision Layer action, use Q_A directly.
// Q_A is already normalized 0–1; multiply by 100 to match the score scale.
const attachedAction = token._e3d_action || null;
if (attachedAction && Number.isFinite(attachedAction.action_score)) {
  thesis_signal_score = Math.round(attachedAction.action_score * 100);
}
```

For tokens that appear in both the standard universe and the action feed (i.e., `seen.has(addr)` was already true), look up the matching action from `e3dActions` by address and attach `_e3d_action` before scoring:

```javascript
const matchingAction = e3dActions.find(a => cleanAddress(a.token_address) === token.address);
if (matchingAction) token._e3d_action = { ... };
```

#### 5.1.4 Include action context in the LLM scout prompt

In the evidence packet / scout prompt builder, when `_e3d_action` is present, include a structured signal block:

```javascript
if (token._e3d_action) {
  const a = token._e3d_action;
  evidenceItems.push({
    source: "E3D Decision Layer",
    action_type: a.action_type,
    action_score: a.action_score,
    confidence: a.confidence,
    risk_score: a.risk_score,
    expected_direction: a.expected_direction,
    horizon_hours: a.expected_horizon,
    supporting_stories: a.n_supporting,
    trigger: a.trigger_reason,
  });
}
```

This gives the LLM scout agent the same structured context that the E3D UI exposes — the signal is no longer implicit in raw thesis fields.

#### 5.1.5 Avoid filter: suppress tokens with active avoid/confirm_risk actions

Build an avoid set from the action feed before token universe filtering. Add a call for bearish action types alongside the accumulate/watch fetch:

```javascript
const e3dAvoidActionsRaw = endpointArray(fetchJson("/actions", {
  status: "open",
  actionType: "avoid,confirm_risk",
  minRisk: 0.50,
  limit: 50
}));
const avoidAddresses = new Set(
  e3dAvoidActionsRaw
    .map(a => cleanAddress(a.token_address || ""))
    .filter(Boolean)
);
log("scout_avoid_set", { count: avoidAddresses.size });
```

In the universe filter loop, add:

```javascript
if (avoidAddresses.has(token.address)) {
  log("scout_token_suppressed_avoid_action", { address: token.address, symbol: token.symbol });
  continue;
}
```

This prevents the LLM from even seeing a token that E3D has flagged as structurally dangerous.

---

### 5.2 Phase B — Harvest: exit pre-check before LLM

**File:** `pipeline.js`

**Location:** The harvest cycle, before the harvest LLM call is dispatched for each held position.

#### 5.2.1 Per-position action lookup

For each position in the harvest loop, query the action feed:

```javascript
async function fetchPositionExitSignal(tokenAddress) {
  if (!tokenAddress) return null;
  const result = fetchJson("/actions", {
    tokenAddress: cleanAddress(tokenAddress),
    status: "open",
    limit: 5
  });
  const actions = endpointArray(result);
  // Prefer highest-severity signal
  const priority = ["avoid", "confirm_risk", "reduce_exposure_signal"];
  for (const type of priority) {
    const match = actions.find(a => a.action_type === type);
    if (match) return match;
  }
  return null;
}
```

#### 5.2.2 Fast-path exit for unambiguous structural signals

Before dispatching the harvest LLM:

```javascript
const exitSignal = fetchPositionExitSignal(position.contract_address);
if (exitSignal) {
  log("harvest_decision_layer_exit_signal", {
    address: position.contract_address,
    symbol: position.symbol,
    action_type: exitSignal.action_type,
    risk_score: exitSignal.risk_score,
    action_score: exitSignal.action_score,
    trigger_reason: exitSignal.trigger_reason
  });

  // Hard exit: avoid or confirm_risk at high risk — skip LLM entirely
  if (
    (exitSignal.action_type === "avoid" || exitSignal.action_type === "confirm_risk") &&
    exitSignal.risk_score > 0.65
  ) {
    return buildFastPathExitDecision(position, exitSignal);
  }

  // Soft signal: reduce_exposure — pass to LLM as high-priority context
  // (handled in 5.2.3 below)
}
```

#### 5.2.3 Inject exit signal into harvest LLM context

For `reduce_exposure_signal` or lower-risk cases, include the action in the harvest evidence packet rather than bypassing the LLM:

```javascript
if (exitSignal) {
  harvestEvidencePacket.decision_layer_signal = {
    action_type:    exitSignal.action_type,
    risk_score:     exitSignal.risk_score,
    confidence:     exitSignal.confidence,
    trigger_reason: exitSignal.trigger_reason,
    action_id:      exitSignal.action_id,
  };
}
```

The harvest LLM system prompt should note: *"If a `decision_layer_signal` is present in the evidence packet, treat it as a high-weight structural signal from the E3D OTA pipeline. An `avoid` or `confirm_risk` signal with risk_score > 0.65 is a strong exit indicator."*

#### 5.2.4 buildFastPathExitDecision

```javascript
function buildFastPathExitDecision(position, action) {
  return {
    exit: true,
    fast_path: true,
    reason: `Decision Layer fast-path exit: ${action.action_type} (risk_score=${action.risk_score.toFixed(2)})`,
    decision_layer_action_id: action.action_id,
    decision_layer_action_type: action.action_type,
    decision_layer_risk_score: action.risk_score,
    decision_layer_trigger: action.trigger_reason,
  };
}
```

Log fast-path exits separately so they can be tracked in the audit trail and attributed in performance analysis.

---

### 5.3 Phase C — Outcome correlation: link trades to E3D action outcomes

**Files:** `pipeline.js` (candidate building), `scripts/recordOutcomes.js`

#### 5.3.1 Store action_id on candidates

When a candidate is sourced from or matched to an E3D action, attach the `action_id` to the candidate object in `buildScoutCandidate()`:

```javascript
if (token._e3d_action?.action_id) {
  candidate.e3d_action_id  = token._e3d_action.action_id;
  candidate.e3d_action_type = token._e3d_action.action_type;
}
```

This flows into the ledger entry via the existing `buildTrainingEventRecord` path.

#### 5.3.2 Enrich recordOutcomes with E3D action outcome

In `scripts/recordOutcomes.js`, after computing `outcome_label` for an entry, check whether the entry has an `e3d_action_id`:

```javascript
async function fetchE3dActionOutcome(actionId) {
  if (!actionId) return null;
  try {
    const url = `${E3D_API_BASE_URL}/actions/${encodeURIComponent(actionId)}/outcome`;
    const curlArgs = ["-s", "--max-time", "15", url];
    if (E3D_API_KEY) curlArgs.push("-H", `x-api-key: ${E3D_API_KEY}`);
    const stdout = execFileSync("curl", curlArgs, { encoding: "utf8", timeout: 20000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
```

In the main outcome loop, after `entry.outcomes` is computed:

```javascript
// Correlate with E3D Decision Layer outcome if an action_id was stored
const actionId = entry?.scout?.candidates?.[0]?.e3d_action_id || null;
if (actionId && !entry.outcomes?.e3d_outcome_fetched) {
  const e3dOutcome = await fetchE3dActionOutcome(actionId);
  if (e3dOutcome && !e3dOutcome.error) {
    entry.outcomes.e3d_thesis_confirmed    = e3dOutcome.thesis_confirmed ?? null;
    entry.outcomes.e3d_confirmation_score  = e3dOutcome.confirmation_score ?? null;
    entry.outcomes.e3d_outcome_score       = e3dOutcome.outcome_score ?? null;
    entry.outcomes.e3d_price_return        = e3dOutcome.price_return ?? null;
    entry.outcomes.e3d_outcome_fetched     = true;
    updatedCount++;
  }
}
```

This adds `e3d_thesis_confirmed` to the training event record. When Qwen sees a training event with `outcome_label: "win"` and `e3d_thesis_confirmed: true`, both sides of the intelligence loop are represented in a single record.

---

### 5.4 Phase D — Dashboard: Decision Layer health metrics

**File:** `dashboard/app.js`

#### 5.4.1 Fetch summary endpoints

Add two new API calls to the dashboard data-fetch sequence:

```javascript
const actionsSummary  = fetchE3dJson("/actions/summary");
const outcomesSummary = fetchE3dJson("/outcomes/summary");
```

#### 5.4.2 Add a Decision Layer panel

Below the existing pipeline stats panel, add a "Decision Layer" section:

```
DECISION LAYER
Open Actions: 14       Accumulate: 5   Watch: 7   Avoid: 2
30d Confirmation Rate: 68.4%
30d Mean Q_O: +0.61    Evaluated: 47
```

This gives the operator a live view of E3D signal quality without leaving the dashboard.

---

## 6. Data Flow After Integration

```
GET /actions (open, accumulate/watch)
      ↓
buildScoutTokenUniverse()
  — token._e3d_action attached (action_id, action_score, direction, horizon)
  — avoidAddresses set removes flagged tokens before LLM sees them
      ↓
computeCandidateSignalScores()
  — thesis_signal_score = action_score * 100  (for action-sourced tokens)
      ↓
LLM Scout Agent
  — evidence packet includes structured Decision Layer signal block
      ↓
buildScoutCandidate()
  — candidate.e3d_action_id stored in ledger entry
      ↓
Harvest cycle (per position)
  GET /actions?tokenAddress=  (open, avoid/confirm_risk/reduce)
  — risk_score > 0.65 → fast-path exit, no LLM
  — lower risk → signal injected into harvest LLM context
      ↓
recordOutcomes.js (≥1h after cycle)
  GET /actions/:actionId/outcome
  — e3d_thesis_confirmed, e3d_confirmation_score added to training event
      ↓
Training events in ClickHouse
  — both trading outcome (win/loss) and E3D thesis outcome in same row
```

---

## 7. New Constants and Configuration

Add to `pipeline.js` settings / constants block:

```javascript
const E3D_ACTIONS_MIN_CONFIDENCE    = Number(process.env.E3D_ACTIONS_MIN_CONFIDENCE || 0.40);
const E3D_ACTIONS_MAX_RISK          = Number(process.env.E3D_ACTIONS_MAX_RISK || 0.65);
const E3D_ACTIONS_ENRICH_LIMIT      = Number(process.env.E3D_ACTIONS_ENRICH_LIMIT || 12);
const E3D_AVOID_RISK_FAST_PATH_FLOOR = Number(process.env.E3D_AVOID_RISK_FAST_PATH_FLOOR || 0.65);
```

All thresholds are environment-variable-overridable so they can be tuned without code changes.

---

## 8. New Log Events

| Event key | When emitted | Key fields |
|---|---|---|
| `scout_e3d_actions` | After `/actions` fetch | `count` |
| `scout_action_enrichment` | After action-sourced universe enrichment | `checked`, `added` |
| `scout_avoid_set` | After avoid address set built | `count` |
| `scout_token_suppressed_avoid_action` | Token removed from universe due to avoid/confirm_risk action | `address`, `symbol` |
| `harvest_decision_layer_exit_signal` | Action signal found for held position | `action_type`, `risk_score`, `trigger_reason` |
| `harvest_fast_path_exit` | LLM bypassed due to high-risk structural signal | `address`, `action_type`, `action_id` |

---

## 9. Success Criteria

### Phase A — Scout
- [ ] `/actions?status=open&actionType=accumulate_signal,paper_buy,watch` returns results and is logged as `scout_e3d_actions`
- [ ] Action-sourced tokens appear in `tokenUniverse` with `_e3d_action` attached
- [ ] `thesis_signal_score` for action-sourced tokens equals `round(action_score * 100)`, verified in pipeline log
- [ ] LLM scout evidence packet includes `E3D Decision Layer` signal block for action-sourced tokens
- [ ] Tokens with `avoid` or `confirm_risk` open actions do not reach the LLM shortlist
- [ ] Both `e3dTheses` and `e3dActions` appear in the return value of `buildScoutTokenUniverse()`

### Phase B — Harvest
- [ ] `fetchPositionExitSignal()` is called for each held position each harvest cycle
- [ ] Fast-path exit fires when `action_type in (avoid, confirm_risk)` and `risk_score > 0.65`; `harvest_fast_path_exit` is logged
- [ ] LLM is still called for `reduce_exposure_signal` at lower risk; evidence packet contains `decision_layer_signal`
- [ ] Fast-path exits appear in the audit trail via `recordOperatorAction`

### Phase C — Outcome correlation
- [ ] `e3d_action_id` is stored on candidates that originate from or match a Decision Layer action
- [ ] `recordOutcomes.js` fetches E3D action outcome when `e3d_action_id` is present and horizon has elapsed
- [ ] Ledger entries for action-sourced trades include `e3d_thesis_confirmed`, `e3d_confirmation_score`, `e3d_outcome_score`
- [ ] ClickHouse training event rows include E3D outcome fields

### Phase D — Dashboard
- [ ] Dashboard shows Decision Layer panel with open count, by-type breakdown, 30d confirmation rate, mean Q_O
- [ ] Panel updates each dashboard refresh cycle
- [ ] Empty/error state renders cleanly if E3D API is unreachable

---

## 10. Implementation Order

| Phase | Effort | Dependency |
|---|---|---|
| A — Scout action feed | Medium | E3D `/actions` endpoint live (Phase 1 complete) |
| D — Dashboard stats | Small | Phase A (same fetch infrastructure) |
| B — Harvest exit pre-check | Small | Phase A (avoid set logic already in place) |
| C — Outcome correlation | Small | Phase A (`e3d_action_id` on candidates) |

Phase A is the foundation. D, B, and C are incremental additions that reuse the same fetch client and constants.

---

*Decision Layer API Integration Feature Ticket — E3D Agent Trading Floor — 2026-05-19*
