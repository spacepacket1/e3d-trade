# Evidence-First Agent Token Budget and Evidence Quality Feature Ticket

## Summary

Improve the E3D Agent Trading Floor's Scout and Harvest loops by moving evidence collection, evidence qualification, and candidate shortlisting into deterministic code before any local LLM call.

The current system can produce professional paper-trading reports, but recent cycles show two weaknesses:

- Scout spends a large token budget reviewing broad candidate sets on a local Qwen model.
- Some Scout and Harvest outputs are flagged as thin evidence after the LLM has already consumed the context.

This feature makes the pipeline evidence-first: deterministic code builds compact evidence packets, filters under-evidenced candidates, and gives the LLM a small shortlist to rank and explain. The goal is to reduce local model runtime and token usage while improving trade/review quality.

## Goals

- Reduce Scout and Harvest prompt and completion token usage without changing the local model.
- Reduce or eliminate `SCOUT_THIN_EVIDENCE` and `HARVEST_THIN_EVIDENCE` warnings.
- Make evidence quality measurable before LLM review.
- Keep AI judgment focused on ranking and interpretation, not broad discovery.
- Preserve paper-trading behavior unless low-quality candidates are explicitly downgraded or blocked by new evidence gates.
- Keep all changes deterministic, auditable, and safe for paper/research/shadow workflows.

## Non-Goals

- Do not enable live trading.
- Do not add paid data providers.
- Do not replace the local Qwen model.
- Do not redesign the dashboard.
- Do not implement venue adapters, custody, wallets, private keys, or live routing.
- Do not loosen risk controls to increase trade count.
- Do not remove existing professional trading system modules added in earlier phases.

## Global Constraints

- Work in `/Users/mini/e3d-agent-trading-floor`.
- Do not touch `node_modules`.
- Keep changes scoped.
- Preserve existing behavior unless the feature explicitly adds evidence metadata, shortlisting, or deterministic low-evidence downgrade/blocking.
- Backtest/replay must not mutate `portfolio.json`.
- Paper pipeline runs may mutate `portfolio.json` only through existing paper-mode behavior.
- No live order submission may become possible.
- Run verification before finishing each phase.

## Common Files To Read

Every phase should start by reading the relevant parts of:

- `docs/evidence-first-agent-token-budget-feature-ticket-20260428.md`
- `pipeline.js`
- `scripts/marketDataQuality.js`
- `scripts/riskEngine.js`
- `scripts/tokenRiskScanner.js`
- `scripts/performanceDaily.js`
- `scripts/tradeReviewer.js`
- `scripts/signalAttribution.js`
- `server.js`
- `dashboard/app.js`
- `package.json`

## Phase 1 - Baseline Measurement and Evidence Diagnostics

Add deterministic diagnostics that show where token budget and thin evidence are coming from before changing candidate selection behavior.

### Requirements

- Add a small reusable measurement helper, such as `scripts/evidenceDiagnostics.js`.
- Capture per-cycle Scout and Harvest diagnostics:
  - input candidate count
  - LLM batch count
  - prompt chars
  - prompt tokens when available
  - completion tokens when available
  - total tokens when available
  - LLM duration
  - candidates returned
  - candidates with full evidence
  - candidates with thin evidence
  - evidence count distribution
  - evidence source distribution when inferable
- For Harvest, capture:
  - positions reviewed
  - exit candidates returned
  - exit candidates with full evidence
  - exit candidates with thin evidence
  - story coverage fields already produced by the pipeline
- Write the diagnostics into the existing cycle report where small and safe.
- Log a compact `evidence_diagnostics` event to `logs/pipeline.jsonl`.
- Do not change Scout or Harvest decisions in this phase.

### Acceptance Criteria

- A normal paper pipeline cycle still runs.
- Existing reports still load.
- The latest cycle report exposes token/evidence diagnostics in a compact form.
- No candidate or trade behavior changes are introduced in this phase.
- `npm run check` passes.

## Phase 2 - Deterministic Evidence Packet Builder

Create a deterministic evidence packet builder that compacts story, market, flow, liquidity, thesis, watchlist, token-risk, and data-quality context per token.

### Requirements

- Add a reusable module, such as `scripts/evidencePackets.js`.
- Build compact evidence packets for Scout buy candidates and Harvest position reviews.
- Each packet should include stable identifiers:
  - `evidence_packet_id`
  - `symbol`
  - `contract_address`
  - `packet_type`: `scout_candidate` or `harvest_position`
  - `created_at`
  - `strategy_version` where available
- Each evidence item should include:
  - `evidence_id`
  - `source_type`: `story`, `market_data`, `flow`, `liquidity`, `thesis`, `watchlist`, `token_risk`, `data_quality`, `portfolio`, `performance`, or `manual`
  - `source_ref` when available
  - `label`
  - `direction`: `bullish`, `bearish`, `neutral`, or `risk`
  - `strength`: integer 0-100
  - `freshness_seconds` when available
  - `summary`: compact text only
- Add deterministic scoring:
  - `evidence_count`
  - `bullish_count`
  - `bearish_count`
  - `risk_count`
  - `market_evidence_count`
  - `story_evidence_count`
  - `quality_score`
  - `missing_evidence`
  - `blockers`
  - `warnings`
- Keep packet text compact. Prefer references and short summaries over raw story dumps.
- Include unit-style verifier script, such as `scripts/verifyEvidencePackets.js`.

### Acceptance Criteria

- Evidence packet IDs are stable for the same normalized inputs.
- Evidence scoring is deterministic.
- Under-evidenced packets produce warnings/blockers without calling an LLM.
- The verifier covers at least:
  - a strong Scout candidate
  - a flow-only Scout candidate
  - a weak Scout candidate
  - a Harvest exit candidate with direct risk evidence
  - a Harvest position with no direct exit evidence
- `npm run check` passes after adding the verifier to the check script if appropriate.

## Phase 3 - Evidence-Gated Scout Shortlisting

Use evidence packets to reduce Scout token budget and prevent weak candidates from reaching the LLM as buy candidates.

### Requirements

- Integrate `scripts/evidencePackets.js` into `runScoutDirect` or the nearest existing Scout data preparation flow.
- Build evidence packets before Scout LLM batching.
- Rank candidate packets deterministically before LLM review.
- Add Scout eligibility gates:
  - normal buy candidate requires at least 3 evidence items
  - at least 1 evidence item must be market, liquidity, flow, or data-quality evidence
  - at least 1 evidence item must be story, thesis, E3D candidate, or watchlist evidence unless explicitly classified as `flow_only`
  - flow-only candidate requires stronger liquidity and volume evidence
  - flow-only candidates are capped to 1 per cycle
  - candidates with hard token-risk or data-quality blockers are not sent to Scout as buy candidates
- Replace broad candidate batching with a compact shortlist:
  - default target: top 12 eligible packets
  - keep the cap configurable by environment variable, for example `SCOUT_EVIDENCE_SHORTLIST_LIMIT`
  - preserve a conservative fallback if packet building fails
- Update the Scout prompt so the LLM:
  - ranks from supplied evidence packets
  - cites `evidence_id` values
  - does not invent evidence
  - returns up to 3 candidates
- Post-validate Scout output:
  - candidate evidence refs must match supplied packet evidence IDs
  - candidates with too few valid refs are downgraded to monitor or dropped before risk/sizing
  - log downgrades as deterministic events
- Preserve existing risk, sizing, execution simulation, order lifecycle, and paper-trade behavior for approved candidates.

### Acceptance Criteria

- Scout prompt size is materially smaller than the prior broad batching path.
- Scout LLM batches are reduced for typical cycles.
- Every Scout candidate that reaches risk has a linked `evidence_packet_id`.
- Every Scout candidate that reaches risk has at least 3 valid evidence references or was explicitly allowed by a documented flow-only exception.
- Thin-evidence Scout candidates are downgraded/dropped before risk, not merely warned after report generation.
- No live trading is enabled.
- `npm run check` passes.

## Phase 4 - Evidence-Gated Harvest Reviews

Use evidence packets to improve Harvest exit quality and reduce unnecessary exit proposals.

### Requirements

- Build Harvest evidence packets for each held position before the Harvest LLM call.
- Include direct held-position context:
  - quantity
  - average entry price
  - current price
  - market value
  - unrealized PnL
  - holding age
  - position risk metadata when available
- Include direct exit-risk evidence:
  - security risk
  - liquidity drain
  - treasury distribution
  - concentration shift
  - spread/slippage degradation
  - strong distribution flow
  - stale/missing data warnings
- Include hold-confirming evidence:
  - accumulation flow
  - thesis support
  - positive story evidence
  - improving liquidity
- Update Harvest prompt so the LLM receives compact per-position packets rather than broad raw story context.
- Require Harvest exit candidates to cite at least 2 valid `evidence_id` refs.
- If an exit/trim candidate has fewer than 2 valid refs, deterministically downgrade it to `monitor`.
- Preserve full position review coverage: every held position must still receive a hold/monitor/trim/exit review.
- Keep the mass-exit guardrail intact.

### Acceptance Criteria

- Every Harvest exit candidate has an `evidence_packet_id`.
- Every Harvest exit candidate has at least 2 valid evidence refs.
- Weak Harvest exits are downgraded to monitor before executor review.
- Harvest still reviews every held position.
- Harvest prompt size is reduced or held stable while evidence quality improves.
- No existing paper accounting behavior is broken.
- `npm run check` passes.

## Phase 5 - Evidence References Across Risk, Orders, Trades, and Reports

Thread evidence packet references through downstream risk decisions, order lifecycle records, paper trades, and reports.

### Requirements

- Attach evidence metadata to risk decisions where small and safe:
  - `evidence_packet_id`
  - `evidence_quality_score`
  - `evidence_ref_count`
  - `evidence_blockers`
  - `evidence_warnings`
- Attach evidence metadata to order lifecycle records:
  - `evidence_packet_id`
  - compact evidence summary
  - valid evidence refs used by the agent
- Attach evidence metadata to paper trades/action history where small and safe.
- Update trade review and signal attribution helpers to prefer evidence refs when available.
- Update cycle report summary to show:
  - evidence-qualified candidates
  - evidence-blocked candidates
  - Scout token budget reduction metrics
  - Harvest evidence downgrade count
- Keep report additions compact.

### Acceptance Criteria

- A paper trade can be traced from trade/order to evidence packet.
- Risk rejections caused by evidence blockers are auditable.
- Reports show evidence quality without dumping raw story text.
- Existing dashboard/report consumers do not crash if old records lack evidence metadata.
- `npm run check` passes.

## Phase 6 - Dashboard Visibility and Operator Tuning

Add small dashboard/API visibility for evidence quality and token budget without redesigning the dashboard.

### Requirements

- Add or extend a small API response in `server.js` only if needed.
- Surface compact evidence/token-budget fields in the dashboard:
  - latest Scout token usage
  - latest Harvest token usage
  - Scout shortlisted candidate count
  - evidence-qualified count
  - evidence-blocked count
  - downgraded weak Scout candidates
  - downgraded weak Harvest exits
- Add candidate detail visibility for:
  - `evidence_packet_id`
  - evidence quality score
  - top 3 compact evidence labels
  - blockers/warnings
- Do not redesign the dashboard.
- Do not add large raw evidence text to the UI.
- Keep UI changes defensive for old reports.

### Acceptance Criteria

- Dashboard loads with old and new report schemas.
- Latest report shows why candidates were qualified, blocked, or downgraded.
- UI remains compact and does not display large raw story dumps.
- `npm run check` passes.

## Phase 7 - Regression Verification and Token Budget Guardrails

Add verification scripts and guardrails so future changes do not reintroduce broad prompts or thin evidence regressions.

### Requirements

- Add a verification script, such as `scripts/verifyEvidenceFirstAgents.js`.
- Verify:
  - evidence packets are deterministic
  - Scout shortlist cap is respected for synthetic inputs
  - weak Scout candidates are blocked or downgraded
  - weak Harvest exits are downgraded to monitor
  - evidence refs must match packet evidence IDs
  - old records without evidence metadata remain readable
- Add token budget guardrails:
  - warn when Scout prompt chars exceed a configured threshold
  - warn when Scout batch count exceeds a configured threshold
  - warn when Harvest prompt chars exceed a configured threshold
  - keep warnings as operational/report warnings, not hard crashes
- Add concise documentation for environment variables:
  - `SCOUT_EVIDENCE_SHORTLIST_LIMIT`
  - optional prompt warning thresholds
  - optional evidence gate thresholds

### Acceptance Criteria

- Verification script passes.
- `npm run check` includes the new verification where appropriate.
- A synthetic broad candidate set does not produce broad Scout LLM batching.
- Thin evidence warnings are prevented by deterministic downgrade/block behavior in synthetic checks.
- No live trading is enabled.

## Suggested Runner Usage

List phases:

```bash
/Users/mini/codex-spec-runner/bin/codex-spec-runner docs/evidence-first-agent-token-budget-feature-ticket-20260428.md --list
```

Run one phase:

```bash
/Users/mini/codex-spec-runner/bin/codex-spec-runner docs/evidence-first-agent-token-budget-feature-ticket-20260428.md 1
```

Run all phases:

```bash
/Users/mini/codex-spec-runner/bin/codex-spec-runner docs/evidence-first-agent-token-budget-feature-ticket-20260428.md all
```
