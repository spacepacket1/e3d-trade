---
head_sha: f626880e34aed3ccc1e244384ed09c036b580028
focus: default
implementation_run_id: impl-853c86a9132f-repo-20260930192036
---

# Findings

## Local State

Approved idea `idea-853c86a9132f` is being implemented for `/Users/mini/e3d-trade`.

## External Context

portfolio.json has grown to ~64MB because each trade record embeds full order_lifecycle (~5KB), token_risk_scan (~2.6KB), and simulated_execution (~2.2KB) objects, duplicated once in closed_trades and again in action_history (an intentional reconciliation cross-check in reconciliationAccounting.js -- do not remove that duplication). This was pushing both e3d-trade-pipeline and e3d-trade-dashboard past PM2's memory ceiling every cycle (confirmed in ~/.pm2/pm2.log: both killed and restarted roughly every 5 minutes at up to ~1.2GB against a 500M limit). The ceiling has already been raised to 2G as an immediate mitigation (separate commit) -- this candidate is the actual fix for the underlying growth.

SCOPE (code only -- portfolio.json and logs/** are protected_paths in this repo's .e3d-pilot/config.json and must not be touched by this implementation; no historical-data migration is in scope here, that is a separate manual operator-run step done after this lands):

1. Add resolveTradeEvidence(trade) in pipeline.js: if the trade object already has order_lifecycle/token_risk_scan/simulated_execution embedded (historical records, unmigrated), return those directly (backward compatible, zero behavior change for existing data). If instead it has an evidence_ref (new records, once this ships), load the corresponding line from logs/trade-evidence.jsonl by trade_id and return that. This helper is pure read-side logic; it does not write anything itself.

2. In executeSell() and openPosition() (and anywhere else a trade record is constructed with order_lifecycle/token_risk_scan/simulated_execution), instead of embedding those three objects inline, write them to logs/trade-evidence.jsonl (append-only, keyed by trade_id) and store only evidence_ref: trade_id on the trade object saved into closed_trades/action_history. This is the only part of the change that writes a new file at runtime; it is not part of the PR's own diff and does not require editing any protected path.

3. Update every consumer currently reading .order_lifecycle/.token_risk_scan/.simulated_execution directly off a trade object to go through resolveTradeEvidence(trade) instead of raw field access: server.js, scripts/reconciliationAccounting.js, scripts/signalAttribution.js (reads directly off action_history entries for BOTH buy and sell sides with no existing fallback -- get this one right, it is the highest-risk consumer), scripts/tradeReviewer.js, scripts/backtestReplay.js, scripts/orderLifecycle.js, scripts/operationsMonitor.js, scripts/evidencePackets.js.

4. Run the existing verify suite (scripts/verify*.js) plus add verification for resolveTradeEvidence covering both the embedded-fallback path (historical records) and the sidecar-lookup path (new records).

After this ships, portfolio.json's growth rate drops to roughly the ~1.5-2KB/trade of scalar fields instead of ~11.4KB/trade -- new trades are cheap going forward. It does NOT shrink the existing ~64MB file; that requires a separate one-time migration script (portfolio.json is a protected path, so that migration must be run manually by the operator, not by e3d-pilot's automated pipeline) that a human runs once this capability has landed and been verified.
