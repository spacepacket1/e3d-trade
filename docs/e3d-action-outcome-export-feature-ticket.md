# Feature Ticket: E3D Action/Outcome Export Bridge

**Project:** E3D Agent Trading Floor → E3D Production Platform  
**Feature:** Export agent verdicts, paper actions, trades, and outcomes from local trading ClickHouse into AWS E3D ClickHouse  
**Target repos:**

1. `e3d-agent-trading-floor` — producer/exporter side
2. E3D main repo — consumer/UI/newsletter side, if needed in a follow-up ticket

**Primary new file:**

```text
scripts/e3dActionOutcomeExport.js
```

**Status:** Ready for implementation  
**Priority:** High  
**Goal:** Turn the trading app into the E3D Action/Outcome Engine without requiring automatic live trading.

---

## 1. Executive Summary

The E3D trading app already runs agentic reasoning over E3D-derived intelligence. It contains scout, harvest, risk, executor, portfolio, sizing, liquidity, market-regime, and paper-trade logic. It also already records rich local telemetry into ClickHouse via the `training_events` table.

The next feature is to add a **one-way exporter** that maps those local trading-app records into clean, product-facing E3D Action/Outcome records in the AWS E3D ClickHouse database.

The objective is **not** to rebuild the trading app. The objective is to expose its most valuable output:

```text
E3D intelligence → agent verdict → simulated capital action → outcome → proof
```

This exporter becomes the bridge between:

```text
Local trading app / private lab
        ↓
Normalized action/outcome export
        ↓
AWS E3D production database
        ↓
E3D UI + newsletter + future scorecards
```

---

## 2. Strategic Context

E3D already has a Decision Layer Action Page supported by story scripts. That layer answers:

> What did E3D detect, and what should be watched or considered?

The trading app adds the higher-level agentic decision layer. It answers:

> Given risk, liquidity, portfolio constraints, slippage, position sizing, market regime, and agent reasoning, what would a disciplined agent actually do?

Therefore, the trading app should be reframed from a “trading app” into the **E3D Action/Outcome Engine** or **E3D Agent Verdict Engine**.

The first production step is to export normalized records from local ClickHouse into the E3D AWS database, so the E3D UI and newsletter can display:

- Agent verdicts
- Paper buys/sells/holds/rejections
- Risk-approved and risk-rejected decisions
- Simulated trade outcomes
- Profit/loss outcomes
- Action scorecards
- Validated and invalidated theses
- “Rejected risk” receipts

---

## 3. Existing Trading App Evidence Stream

The current `pipeline.js` already defines local persistence behavior.

Default local ClickHouse configuration:

```js
const CLICKHOUSE_HTTP_URL = process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
```

Current `training_events` schema is created in `ensurePersistentStores()`:

```sql
CREATE TABLE IF NOT EXISTS e3d.training_events (
  event_id String,
  schema_version String,
  ts String,
  event_type String,
  actor String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime String,
  candidate_id String,
  position_id String,
  trade_id String,
  payload String
)
ENGINE = MergeTree
ORDER BY (ts, event_type, event_id)
```

Relevant existing event writers:

- `recordCandidateEvent(...)`
- `recordRiskDecisionEvent(...)`
- `recordRiskEngineDecisionEvent(...)`
- `recordExecutorDecisionEvent(...)`
- `recordTradeEvent(...)`
- `recordOutcomeEvent(...)`
- `recordAuxiliaryEvent(...)`
- `recordCycleEvent(...)`

The exporter should reuse these existing events rather than modifying core trading logic.

---

## 4. Core Requirement

Create `scripts/e3dActionOutcomeExport.js` in the `e3d-agent-trading-floor` repo.

The script must:

1. Read local trading app records from local ClickHouse.
2. Select relevant `training_events` records.
3. Parse each event’s `payload` JSON.
4. Map internal event records into stable E3D-facing schemas.
5. Insert mapped records into AWS E3D ClickHouse tables.
6. Avoid duplicate logical records.
7. Maintain a local export watermark.
8. Support dry-run mode.
9. Be safe to run repeatedly by cron/systemd.
10. Log useful summaries and errors.

---

## 5. Non-Goals

Do **not** implement automatic live trading in this ticket.

Do **not** rewrite scout, harvest, risk, executor, portfolio, or paper-trade logic.

Do **not** force the E3D production UI to consume raw `training_events` directly.

Do **not** create user-specific custom agents.

Do **not** create two-way sync between AWS E3D and the local trading app.

Do **not** mutate local trading-app state based on AWS data.

This feature is a **one-way export bridge**:

```text
Local trading app ClickHouse → AWS E3D ClickHouse
```

---

## 6. Architecture

### 6.1 Data Flow

```text
pipeline.js
  ↓
local ClickHouse: e3d.training_events
  ↓
scripts/e3dActionOutcomeExport.js
  ↓
AWS ClickHouse:
  - E3DAgentActions
  - E3DAgentOutcomes
  - E3DAgentCycleScorecards
  - optional E3DAgentExportAudit
  ↓
E3D UI / newsletter / future APIs
```

### 6.2 Local Source

Default source:

```text
http://127.0.0.1:8123
Database: e3d
Table: training_events
```

Allow override via environment variables:

```bash
LOCAL_CLICKHOUSE_HTTP_URL=http://127.0.0.1:8123
LOCAL_CLICKHOUSE_DATABASE=e3d
LOCAL_TRAINING_EVENTS_TABLE=training_events
```

### 6.3 AWS Destination

Use separate env vars so we do not confuse local and production destinations:

```bash
AWS_E3D_CLICKHOUSE_HTTP_URL=https://your-aws-clickhouse-host:8123
AWS_E3D_CLICKHOUSE_DATABASE=e3d
AWS_E3D_CLICKHOUSE_USER=default
AWS_E3D_CLICKHOUSE_PASSWORD=...
AWS_E3D_CLICKHOUSE_SECURE=true
```

If the existing E3D app uses a different env naming convention, adapt to match that repo’s standards, but keep source/destination names clearly separate.

---

## 7. Recommended Runtime Model

### 7.1 Development

Run manually first:

```bash
node scripts/e3dActionOutcomeExport.js --since-hours=24 --dry-run
node scripts/e3dActionOutcomeExport.js --since-hours=24
```

### 7.2 Initial Production

Run every 5 minutes via cron on the machine running the trading app:

```cron
*/5 * * * * cd /Users/mini/e3d-agent-trading-floor && /usr/local/bin/node scripts/e3dActionOutcomeExport.js >> logs/e3d-action-outcome-export.log 2>&1
```

### 7.3 Later Production

After stable operation, either:

- keep cron every 5 minutes, or
- move to `systemd` timer on Linux, or
- run every 1 minute if near-real-time E3D UI updates are needed.

Do not implement a long-running daemon in this ticket unless explicitly requested later.

---

## 8. Dedupe and Watermark Strategy

Use **two layers of duplicate protection**:

1. Local export watermark with overlap window
2. Deterministic IDs in destination tables

### 8.1 Local State File

Create:

```text
state/e3d-action-outcome-export-state.json
```

Example:

```json
{
  "schema_version": "1.0",
  "last_watermark_ts": "2026-05-19T20:15:00-07:00",
  "last_event_id": "event-id",
  "last_run_started_at": "2026-05-19T20:20:00-07:00",
  "last_run_completed_at": "2026-05-19T20:20:12-07:00",
  "last_success_count": 248,
  "last_error": null
}
```

### 8.2 Lock File

Create:

```text
state/e3d-action-outcome-export.lock
```

Behavior:

- If lock exists and is recent, exit with a clear log message.
- If lock exists but is stale, remove it and continue.
- Default stale threshold: 30 minutes.

### 8.3 Overlap Window

Each export should query slightly before the last watermark to avoid missing late or out-of-order records.

Default:

```text
EXPORT_OVERLAP_MINUTES=10
```

Query concept:

```sql
SELECT *
FROM e3d.training_events
WHERE ts >= '{last_watermark_ts_minus_overlap}'
  AND event_type IN (...)
ORDER BY ts, event_id
LIMIT 5000
```

On first run, use `--since-hours` or default to 24 hours.

### 8.4 Deterministic IDs

Generate stable IDs so rerunning the exporter does not create duplicate logical records.

#### Action ID

```js
action_id = sha256([
  pipeline_run_id,
  cycle_id,
  candidate_id,
  trade_id,
  event_type,
  actor,
  normalizedDecision,
  normalizedTokenAddress
].join("|"));
```

#### Outcome ID

```js
outcome_id = sha256([
  action_id,
  trade_id,
  position_id,
  outcome_window,
  measured_at,
  event_type
].join("|"));
```

#### Cycle Scorecard ID

```js
scorecard_id = sha256([
  pipeline_run_id,
  cycle_id,
  cycle_index
].join("|"));
```

### 8.5 ClickHouse Deduping

Use `ReplacingMergeTree(updated_at)` for AWS destination tables.

This allows repeat inserts of the same deterministic ID while keeping the latest version queryable.

---

## 9. Event Types to Export

### 9.1 Phase 1 Minimum

Export these first:

```text
executor_decision
trade
outcome
```

### 9.2 Phase 2 Expansion

Add:

```text
candidate
risk_decision
risk_engine_decision
cycle_start
cycle_end
manager_report
regime_policy
signal_snapshot
token_risk_scan
market_data_quality
```

### 9.3 Mapping Concept

```text
executor_decision → E3DAgentActions
trade             → E3DAgentOutcomes or E3DAgentExecutions
outcome           → E3DAgentOutcomes
cycle_*           → E3DAgentCycleScorecards
risk_*            → enrich actions with risk verdicts
candidate         → enrich actions with scout candidate context
```

For this ticket, create core tables and map the minimum set. Leave obvious extension points for the rest.

---

## 10. Destination Schema

### 10.1 `E3DAgentActions`

Purpose: one row per agent verdict/action candidate.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentActions
(
  action_id String,
  updated_at DateTime64(3),
  created_at DateTime64(3),

  source_app LowCardinality(String),
  source_schema_version String,
  source_event_id String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  token_address String,
  symbol String,
  chain LowCardinality(String),

  agent_stage LowCardinality(String),
  actor LowCardinality(String),
  event_type LowCardinality(String),
  trade_kind LowCardinality(String),

  agent_decision LowCardinality(String),
  action_type LowCardinality(String),
  simulated_side LowCardinality(String),

  candidate_id String,
  position_id String,
  trade_id String,

  entry_price Float64,
  allocation_usd Float64,
  confidence_score Float64,
  risk_score Float64,
  liquidity_usd Float64,
  slippage_bps Float64,
  fee_bps Float64,

  thesis_summary String,
  reason_summary String,
  reject_reason String,

  source_story_ids Array(String),
  source_signal_types Array(String),
  evidence_packet_id String,
  risk_decision_id String,

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (action_id);
```

Notes:

- `agent_decision` examples: `approve`, `reject`, `buy`, `sell`, `hold`, `wait`, `exit`, `unknown`
- `action_type` examples: `PAPER_BUY`, `PAPER_SELL`, `PAPER_HOLD`, `PAPER_EXIT`, `REJECT`, `WAIT`, `RISK_ALERT`, `WATCH`
- `simulated_side` examples: `buy`, `sell`, `hold`, `none`

### 10.2 `E3DAgentOutcomes`

Purpose: one row per simulated trade or outcome observation.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentOutcomes
(
  outcome_id String,
  action_id String,
  updated_at DateTime64(3),
  measured_at DateTime64(3),

  source_app LowCardinality(String),
  source_schema_version String,
  source_event_id String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  token_address String,
  symbol String,
  chain LowCardinality(String),

  candidate_id String,
  position_id String,
  trade_id String,

  outcome_type LowCardinality(String),
  outcome_window LowCardinality(String),
  outcome_label LowCardinality(String),
  verdict LowCardinality(String),

  entry_price Float64,
  exit_price Float64,
  current_price Float64,
  price_delta_pct Float64,
  pnl_usd Float64,
  pnl_pct Float64,
  max_gain_pct Float64,
  max_drawdown_pct Float64,
  holding_days Float64,

  liquidity_delta_pct Float64,
  volume_delta_pct Float64,
  holder_delta_pct Float64,

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (outcome_id);
```

Notes:

- In phase 1, many delta fields may be `0` or `NULL-equivalent`. That is acceptable.
- `outcome_window` may initially be `realized`, `trade`, or `unknown`.
- Later, add scheduled 1h/4h/24h/7d snapshot outcomes.

### 10.3 `E3DAgentCycleScorecards`

Purpose: one row per pipeline cycle or run-level summary.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentCycleScorecards
(
  scorecard_id String,
  updated_at DateTime64(3),
  created_at DateTime64(3),

  source_app LowCardinality(String),
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  scout_candidates Int32,
  risk_approved Int32,
  risk_rejected Int32,
  executor_decisions Int32,
  paper_buys Int32,
  paper_sells Int32,
  paper_holds Int32,
  paper_rejections Int32,

  cash_usd Float64,
  equity_usd Float64,
  realized_pnl_usd Float64,
  unrealized_pnl_usd Float64,
  open_positions Int32,

  warning_count Int32,
  critical_count Int32,
  score Float64,
  grade LowCardinality(String),

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (scorecard_id);
```

This table can be sparse in phase 1. Implement if easy; otherwise leave as phase 2 with table creation included.

### 10.4 Optional `E3DAgentExportAudit`

Purpose: track exporter runs.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentExportAudit
(
  export_run_id String,
  started_at DateTime64(3),
  completed_at DateTime64(3),
  status LowCardinality(String),
  source_min_ts String,
  source_max_ts String,
  source_events_read Int32,
  actions_written Int32,
  outcomes_written Int32,
  scorecards_written Int32,
  error_message String,
  payload_json String
)
ENGINE = MergeTree
ORDER BY (started_at, export_run_id);
```

---

## 11. Mapping Rules

### 11.1 Common Helpers

Implement helpers:

```js
function cleanAddress(value) { ... }
function toNum(value, fallback = 0) { ... }
function optionalNum(value) { ... }
function parsePayload(row) { ... }
function sha256String(value) { ... }
function normalizeTimestamp(value) { ... }
function safeJson(value) { ... }
```

Reuse logic from `pipeline.js` where appropriate, but avoid importing the full pipeline if that causes side effects.

### 11.2 Extract Token Identity

Try these locations in order:

```js
payload.proposal.token.contract_address
payload.action.candidate.token.contract_address
payload.trade.contract_address
payload.trade.token.contract_address
payload.position_before.contract_address
payload.token.contract_address
row.candidate_id if it is an EVM address
```

Symbol locations:

```js
payload.proposal.token.symbol
payload.action.candidate.token.symbol
payload.trade.symbol
payload.trade.token.symbol
payload.position_before.symbol
payload.token.symbol
```

Default chain:

```text
ETH
```

### 11.3 Map `executor_decision` → `E3DAgentActions`

Source fields:

```js
row.event_type === "executor_decision"
row.actor === "executor"
payload.trade_kind
payload.decision
payload.proposal
payload.review
payload.action
```

Map:

```js
agent_stage      = "executor"
agent_decision   = normalizeExecutorDecision(payload.decision || payload.review?.decision)
action_type      = inferActionType(agent_decision, payload.trade_kind)
simulated_side   = inferSide(payload.trade_kind, payload.action, payload.review)
entry_price      = payload.action?.paper_trade_ticket?.assumed_entry || payload.action?.price || 0
allocation_usd   = payload.action?.paper_trade_ticket?.allocation_usd || payload.action?.allocation_usd || 0
confidence_score = payload.proposal?.conviction_score || payload.proposal?.confidence || payload.review?.confidence || 0
risk_score       = payload.proposal?.fraud_risk || payload.review?.risk_score || 0
liquidity_usd    = payload.proposal?.liquidity_data?.liquidity_usd || payload.action?.paper_trade_ticket?.liquidity_usd || 0
slippage_bps     = payload.proposal?.execution_data?.estimated_slippage_bps || payload.action?.paper_trade_ticket?.max_slippage_bps || 0
thesis_summary   = payload.action?.paper_trade_ticket?.thesis_summary || payload.proposal?.thesis_summary || payload.proposal?.summary || ""
reason_summary   = payload.review?.reason || payload.action?.reason || payload.proposal?.why_now || ""
reject_reason    = payload.review?.reject_reason || payload.review?.reason_code || ""
source_story_ids = payload.proposal?.story_ids || []
source_signal_types = payload.proposal?.signal_types || []
evidence_packet_id = payload.proposal?.evidence_packet_id || payload.action?.paper_trade_ticket?.evidence_packet_id || ""
risk_decision_id = payload.action?.paper_trade_ticket?.risk_decision_id || payload.proposal?.risk_decision_id || ""
payload_json = JSON.stringify(payload)
```

### 11.4 Map `trade` → `E3DAgentOutcomes`

Source fields:

```js
row.event_type === "trade"
payload.trade_id
payload.position_id
payload.candidate_id
payload.quoted_price
payload.fill_price
payload.slippage_bps_applied
payload.fee_bps_applied
payload.trade
```

Map:

```js
outcome_type = "paper_trade"
outcome_window = "trade"
entry_price = payload.trade?.avg_entry_price || payload.quoted_price || payload.fill_price || 0
current_price = payload.fill_price || payload.trade?.price || 0
exit_price = payload.trade?.side === "sell" ? current_price : 0
pnl_usd = payload.trade?.pnl_usd || 0
pnl_pct = derive if possible
outcome_label = payload.trade?.side || "trade"
verdict = "recorded"
payload_json = JSON.stringify(payload)
```

### 11.5 Map `outcome` → `E3DAgentOutcomes`

Source fields:

```js
row.event_type === "outcome"
payload.trade_id
payload.position_id
payload.candidate_id
payload.outcome_label
payload.pnl_usd
payload.exit_price
payload.entry_price
payload.holding_days
payload.position_before
payload.trade
```

Map:

```js
outcome_type = "realized_outcome"
outcome_window = "realized"
entry_price = payload.entry_price || payload.position_before?.avg_entry_price || 0
exit_price = payload.exit_price || payload.trade?.fill_price || payload.trade?.price || 0
current_price = exit_price
pnl_usd = payload.pnl_usd || 0
pnl_pct = derive using entry/exit if possible
holding_days = payload.holding_days || 0
outcome_label = payload.outcome_label || (pnl_usd >= 0 ? "profit" : "loss")
verdict = pnl_usd >= 0 ? "validated" : "invalidated"
payload_json = JSON.stringify(payload)
```

### 11.6 Map Rejections

Do not ignore rejections. Rejections are valuable.

If `executor_decision`, `risk_decision`, or `risk_engine_decision` indicates rejection:

```text
action_type = REJECT
simulated_side = none
```

Reason examples:

- high fraud risk
- thin liquidity
- slippage too high
- risk-off regime
- already held
- missing market data
- token risk scan blockers

Rejected candidates should appear in E3D as:

> Agent rejected this candidate and later outcome tracking can show whether the rejection was validated.

Outcome tracking for rejected candidates can be phase 2.

---

## 12. CLI Requirements

Support:

```bash
node scripts/e3dActionOutcomeExport.js
node scripts/e3dActionOutcomeExport.js --dry-run
node scripts/e3dActionOutcomeExport.js --since-hours=24
node scripts/e3dActionOutcomeExport.js --limit=5000
node scripts/e3dActionOutcomeExport.js --no-state
node scripts/e3dActionOutcomeExport.js --from-ts="2026-05-19T00:00:00-07:00"
node scripts/e3dActionOutcomeExport.js --to-ts="2026-05-20T00:00:00-07:00"
node scripts/e3dActionOutcomeExport.js --create-tables-only
node scripts/e3dActionOutcomeExport.js --verbose
```

Defaults:

```text
limit = 5000
dry_run = false
since_hours on first run = 24
overlap_minutes = 10
lock_stale_minutes = 30
```

---

## 13. Logging Requirements

Append JSONL logs to:

```text
logs/e3d-action-outcome-export.jsonl
```

Each run logs:

```json
{
  "ts": "...",
  "stage": "export_summary",
  "export_run_id": "...",
  "source_events_read": 120,
  "actions_mapped": 40,
  "outcomes_mapped": 12,
  "scorecards_mapped": 0,
  "actions_inserted": 40,
  "outcomes_inserted": 12,
  "dry_run": false,
  "source_min_ts": "...",
  "source_max_ts": "...",
  "duration_ms": 1234
}
```

On error:

```json
{
  "ts": "...",
  "stage": "export_error",
  "export_run_id": "...",
  "message": "...",
  "stack": "..."
}
```

---

## 14. ClickHouse HTTP Implementation

Implement local and AWS query helpers using `curl` via Node `child_process.execFileSync`, consistent with existing `pipeline.js`, or use native `fetch` if the Node version supports it and repo standards allow it.

Recommended helper interface:

```js
function clickHouseQuery({ baseUrl, database, user, password, query, input = "" }) { ... }
```

For inserts:

```sql
INSERT INTO e3d.E3DAgentActions FORMAT JSONEachRow
```

Body:

```text
{"action_id":"...", ...}
{"action_id":"...", ...}
```

Use batches:

```text
max rows per insert = 1000
```

---

## 15. Security Requirements

- Do not hardcode AWS credentials.
- Read AWS ClickHouse password from env only.
- Do not log passwords or full connection URLs with credentials.
- Allow `.env` loading only if the repo already uses `dotenv`; otherwise document required env vars.
- If `.env` is added, ensure it is gitignored.

---

## 16. Failure Behavior

The exporter should be conservative.

### If local ClickHouse is unavailable

- Log error.
- Exit non-zero.
- Do not modify state watermark.

### If AWS ClickHouse is unavailable

- Log error.
- Exit non-zero.
- Do not modify state watermark.

### If some events fail to parse

- Log parse failures.
- Skip invalid events.
- Continue exporting valid events.
- Include `parse_error_count` in summary.

### If insert partially fails

- Treat run as failed.
- Do not advance watermark.
- Rerun should be safe due to deterministic IDs.

---

## 17. Acceptance Criteria

### 17.1 Table Creation

- Running with `--create-tables-only` creates destination AWS tables if missing.
- Running table creation repeatedly is safe.

### 17.2 Dry Run

- `--dry-run` reads local events and prints/logs mapped action/outcome counts.
- `--dry-run` does not insert into AWS.
- `--dry-run` does not update state watermark.

### 17.3 Export

- Running without `--dry-run` inserts mapped rows into AWS tables.
- `executor_decision` records appear in `E3DAgentActions`.
- `trade` and `outcome` records appear in `E3DAgentOutcomes`.
- Payload JSON is preserved in `payload_json`.

### 17.4 Idempotency

- Running the exporter twice over the same time range does not create duplicate logical records.
- Duplicate source events produce the same deterministic `action_id` or `outcome_id`.
- ClickHouse latest-by-ID query returns one logical row per action/outcome.

### 17.5 Watermark

- Successful export advances `last_watermark_ts`.
- Failed export does not advance watermark.
- Export uses overlap window when querying after a previous watermark.

### 17.6 Locking

- If a lock file exists from a current run, a second process exits without running.
- Stale locks are cleaned up after the configured stale threshold.

### 17.7 Logging

- Each run appends a summary to `logs/e3d-action-outcome-export.jsonl`.
- Errors are logged with stage and message.

---

## 18. Suggested Implementation Phases

### Phase 1: Exporter Skeleton

- Add CLI parser.
- Add env config.
- Add local/AWS ClickHouse helpers.
- Add lock file.
- Add state file.
- Add JSONL logging.

### Phase 2: Destination Tables

- Add `createDestinationTables()`.
- Support `--create-tables-only`.

### Phase 3: Read Local Events

- Query local `training_events`.
- Support `--since-hours`, `--from-ts`, `--to-ts`, `--limit`.
- Apply event type filter.

### Phase 4: Mapping

- Map `executor_decision` to `E3DAgentActions`.
- Map `trade` to `E3DAgentOutcomes`.
- Map `outcome` to `E3DAgentOutcomes`.
- Preserve full payload JSON.

### Phase 5: Insert and Dedupe

- Batch insert JSONEachRow.
- Use deterministic IDs.
- Use ReplacingMergeTree destination tables.

### Phase 6: Manual Validation

Run:

```bash
node scripts/e3dActionOutcomeExport.js --since-hours=24 --dry-run --verbose
node scripts/e3dActionOutcomeExport.js --since-hours=24 --create-tables-only
node scripts/e3dActionOutcomeExport.js --since-hours=24
```

Validate in AWS ClickHouse:

```sql
SELECT count() FROM e3d.E3DAgentActions;
SELECT count() FROM e3d.E3DAgentOutcomes;
SELECT * FROM e3d.E3DAgentActions ORDER BY created_at DESC LIMIT 10;
SELECT * FROM e3d.E3DAgentOutcomes ORDER BY measured_at DESC LIMIT 10;
```

### Phase 7: Cron

Install cron every 5 minutes after manual validation.

---

## 19. Example E3D UI Queries

### Latest Agent Actions

```sql
SELECT
  created_at,
  symbol,
  token_address,
  action_type,
  agent_decision,
  simulated_side,
  confidence_score,
  risk_score,
  entry_price,
  allocation_usd,
  thesis_summary,
  reason_summary
FROM e3d.E3DAgentActions
ORDER BY created_at DESC
LIMIT 100;
```

### Latest Outcomes

```sql
SELECT
  measured_at,
  symbol,
  token_address,
  outcome_type,
  outcome_label,
  verdict,
  entry_price,
  exit_price,
  pnl_usd,
  pnl_pct,
  holding_days
FROM e3d.E3DAgentOutcomes
ORDER BY measured_at DESC
LIMIT 100;
```

### Actions With Outcomes

```sql
SELECT
  a.created_at,
  a.symbol,
  a.action_type,
  a.agent_decision,
  a.entry_price,
  o.measured_at,
  o.outcome_label,
  o.verdict,
  o.pnl_usd,
  o.pnl_pct
FROM e3d.E3DAgentActions a
LEFT JOIN e3d.E3DAgentOutcomes o
  ON a.trade_id = o.trade_id OR a.action_id = o.action_id
ORDER BY a.created_at DESC
LIMIT 100;
```

---

## 20. Future Follow-Up Ticket: E3D UI Integration

After this exporter is working, create a second feature ticket for the E3D main repo:

### UI surfaces

- Add `Agent Verdicts` tab to the existing Decision Layer Action Page.
- Add token-level `Agent Verdict / Outcome` panel.
- Add dashboard summary:
  - actions reviewed
  - paper buys
  - rejections
  - realized outcomes
  - win rate
  - validated rejections
  - top positive outcomes
  - worst false positives

### Newsletter

Add a section:

```text
E3D Agent Verdicts & Outcomes
```

Include:

- top validated agent action
- best rejected risk
- worst invalidated action
- what the engine learned

---

## 21. Product Language

Use this language in comments, UI, and docs:

```text
E3D does not just explain the chain. It tests its own explanations against what happens next.
```

```text
E3D finds interesting structure. The Agent Verdict Engine tests whether that structure survives capital-aware reasoning.
```

Avoid leading with:

```text
trading bot
buy/sell recommendations
automatic trading
```

Prefer:

```text
agent verdicts
simulated actions
paper execution
outcome tracking
signal validation
thesis validation
capital-aware reasoning
```

---

## 22. Definition of Done

This ticket is complete when:

1. `scripts/e3dActionOutcomeExport.js` exists.
2. It can create destination AWS ClickHouse tables.
3. It can dry-run map local events.
4. It can export `executor_decision`, `trade`, and `outcome` records.
5. Exported actions are visible in AWS `E3DAgentActions`.
6. Exported outcomes are visible in AWS `E3DAgentOutcomes`.
7. Re-running the exporter is idempotent.
8. State/watermark and lock files work.
9. Logs provide useful summaries.
10. A cron command is documented and tested manually.

---

## 23. Implementation Notes for AI Agent

When implementing, inspect the existing repo before editing.

Important existing file:

```text
pipeline.js
```

Important existing concepts/functions:

```text
CLICKHOUSE_HTTP_URL
CLICKHOUSE_DATABASE_NAME
CLICKHOUSE_TABLE_NAME
training_events
appendTrainingEvent
syncTrainingEventToClickHouse
recordExecutorDecisionEvent
recordTradeEvent
recordOutcomeEvent
buildTrainingEventRecord
```

Do not import or execute `pipeline.js` from the exporter if doing so triggers pipeline side effects. Prefer copying tiny pure helper functions into the exporter or creating a new shared utility module only if safe.

Keep the first version boring and reliable.

The exporter is infrastructure. It should be easy to understand, easy to rerun, and safe to schedule.
