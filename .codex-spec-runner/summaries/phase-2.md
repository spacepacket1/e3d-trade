# Phase 2 Summary

- Phase: 2
- Title: Migrate Trade Evidence Consumers
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-09-30T14:52:10-0700
- Exit status: 0

## Implementation Handoff

- Scope: Implemented Phase 2 consumer migration for persisted-trade evidence without changing later-phase behavior or report schemas.
- Shared resolver usage: Moved listed read-only consumers off raw top-level evidence reads and onto `resolveTradeEvidence(...)` from `scripts/tradeEvidence.js`.
- `server.js`: Added pure persisted-trade projection helpers, updated execution snapshot/order-risk projections to support embedded and sidecar-backed trades, and avoided dropping trades solely because raw evidence fields are absent.
- `scripts/reconciliationAccounting.js`: Exported `normalizePaperTrades(portfolio, options)` and resolved persisted-trade evidence before paper-trade missing-execution / lifecycle checks while preserving the `closed_trades` vs `action_history` cross-check.
- `scripts/signalAttribution.js`: Exported pure helpers used by the verifier, resolved evidence for buy/open and sell/close action-history reads, and preserved fallback behavior outside the persisted trade’s own three evidence fields.
- `scripts/tradeReviewer.js` and `scripts/operationsMonitor.js`: Added pure exported seams that resolve persisted-trade evidence before review/order-lifecycle derivation.
- `scripts/evidencePackets.js`: Only persisted-trade reads of the trade’s own `token_risk_scan` now resolve through the shared module; candidate/position inputs with their own embedded scan still use that embedded value.
- `scripts/orderLifecycle.js`: `input.execution` still wins. Resolver fallback is used only when `input.execution` is absent, and it does not require a sidecar for embedded construction trades.
- `scripts/backtestReplay.js`: Exported the pure replay-input collection seam for verifier coverage; replay continues to use nested ticket risk inputs and explicit replay execution rather than persisted top-level evidence.
- `scripts/verifyTradeEvidence.js`: Extended the existing verifier instead of adding a new script. It now creates embedded and sidecar-backed in-memory twins, forwards a temp `{ sidecarPath }`, and checks equivalence for server, reconciliation, attribution, review, operations, evidence packets, order lifecycle, and replay inputs only through pure exports.
- Verifier detail: Reconciliation comparisons ignore `evidence_ref` storage artifacts, and evidence-packet comparisons ignore generated `created_at` timestamps so the assertions stay focused on evidence-derived behavior.
- Tests run:
- `node scripts/verifyTradeEvidence.js`
- `npm install`
- `npm run check`
- Verification result: All passed. `npm run check` emitted expected warning-only output from maps-related offline verification and produced the normal reconciliation / attribution report artifacts.
- Unresolved follow-up: None identified within Phase 2 scope.

## Verification
- passed: `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .codex-spec-runner/summaries/phase-1.md`
- ` M .codex-spec-runner/summaries/phase-2.md`
- ` M package.json`
- ` M pipeline.js`
- ` M scripts/backtestReplay.js`
- ` M scripts/evidencePackets.js`
- ` M scripts/operationsMonitor.js`
- ` M scripts/orderLifecycle.js`
- ` M scripts/reconciliationAccounting.js`
- ` M scripts/signalAttribution.js`
- ` M scripts/tradeReviewer.js`
- ` M server.js`
- `?? scripts/tradeEvidence.js`
- `?? scripts/verifyTradeEvidence.js`
