# Sidecar Trade Evidence Storage

## Overview

Add append-only sidecar storage for evidence attached to newly created trades. New portfolio trade records keep the rest of their fields and replace their own top-level evidence objects with `evidence_ref`. Historical records with embedded evidence remain readable without migration.

## Goals

- Reduce future `portfolio.json` growth by externalizing top-level `order_lifecycle`, `token_risk_scan`, and `simulated_execution` from new buy and sell trade records.
- Preserve the intentional duplication between `closed_trades` and `action_history`.
- Provide one resolver supporting embedded historical evidence and sidecar-backed new evidence.
- Update all identified consumers to use the resolver.
- Verify both storage formats, including consumer equivalence, without touching protected runtime data.

## Non-Goals

- Migrating or shrinking existing `portfolio.json`.
- Modifying historical records or existing sidecar log data.
- Removing the reconciliation duplication between `closed_trades` and `action_history`.
- Changing trading, risk, execution, attribution, or accounting policy.
- Externalizing position objects, candidate objects, training-event records, replay-only objects, or nested copies such as `paper_trade_ticket.token_risk_scan`.
- Rewriting `evidence_refs` or `evidence_ref_count`. Those existing fields are unrelated to `evidence_ref`.
- Adding a cache, index, or asynchronous evidence API.
- Externalizing from `savePortfolio` or from any walk of an already loaded portfolio.

## Existing Files

- `pipeline.js` constructs live buy and sell trade records. `openPosition` and `executeSell` attach evidence, insert the same object into portfolio collections, and record training or outcome events that embed that object. `recordTradeEvent` and `recordOutcomeEvent` serialize that object immediately. Some callers then attach risk metadata and call `attachPaperOrderLifecycle` again on the returned trade before a later `savePortfolio`. `savePortfolio` itself persists the portfolio it is given; it is not an evidence hook.
- Live persistence points that can see those trades are the manual-action save inside `applyPendingManualActions`, the trend-sleeve checkpoint save, the end-of-cycle save, and the trend-only save.
- `server.js` exposes trade evidence through dashboard APIs. Importing it must not listen or start the pipeline. Evidence projections used for verification must be pure: no HTTP handler, token-metadata fetch, or portfolio read.
- `scripts/reconciliationAccounting.js`, `scripts/signalAttribution.js`, `scripts/tradeReviewer.js`, `scripts/backtestReplay.js`, `scripts/orderLifecycle.js`, `scripts/operationsMonitor.js`, and `scripts/evidencePackets.js` consume trade evidence. Several exported report entry points read the repository portfolio or logs and some append under `logs/**` or write reports. Those entry points are not the phase 2 equivalence seam.
- `package.json` defines the repository verification suite and uses ESM. `npm run check` already executes read-only report commands against the real portfolio; those commands must keep working for historical embedded trades.
- `logs/trade-evidence.jsonl` will be created only by runtime application behavior and is not part of the implementation diff.

## Shared Constraints

- Do not modify `portfolio.json`, `logs/**`, or any other protected path.
- Do not add a historical-data migration or invoke live trade-writing flows during verification.
- Keep the implementation within 15 changed files and 800 changed lines.
- Preserve support for historical records containing embedded evidence.
- Preserve the existing `closed_trades`/`action_history` reconciliation relationship.
- Sidecar records must be append-only, keyed by `trade_id`, and fsynced before a portfolio record can persist a corresponding reference.
- Tests must use temporary files or directories and must not read or write the repository’s real sidecar log.
- Keep evidence resolution and externalization synchronous where existing consumers are synchronous.
- Use the last valid matching sidecar line when duplicate `trade_id` records exist. File order is the only recency rule; records have no timestamp.
- Tolerate blank or whitespace-only lines, invalid JSON, and well-formed JSON lines that are not valid evidence records.
- A missing, unreadable, or non-matching sidecar must degrade to absent evidence without crashing read-only reports or the dashboard.
- The default sidecar path is `<repository-root>/logs/trade-evidence.jsonl`. The repository root is the parent of the directory that contains `scripts/tradeEvidence.js`, not `process.cwd()`.
- Use ESM named exports. `scripts/tradeEvidence.js` must not import `pipeline.js`.
- A test-only synchronous file-operations override may be supplied to `externalizeTradeEvidence` as described below. Production callers must not supply it.
- `resolveTradeEvidence` is read-only. It must not mutate the trade, the sidecar, or the options object.

## Resolver And Externalization Contract

`scripts/tradeEvidence.js` owns the contract. Both functions accept an optional options object containing `sidecarPath`; otherwise they use the default path above.

`resolveTradeEvidence(trade, options)` returns exactly:

`{ order_lifecycle, token_risk_scan, simulated_execution }`

Each value is either the stored value or `null`. Absent evidence means all three values are `null`. The function does not throw for a null, undefined, or non-object trade, a missing file, an unreadable file, bad JSONL, or no matching record. Those cases return absent evidence.

Embedded evidence wins whenever the trade object has any own property named `order_lifecycle`, `token_risk_scan`, or `simulated_execution`, even when the value is `null` or `undefined`, and even when `evidence_ref` is also present. In that case return those three own properties, using `null` for a missing own property or an `undefined` value, and do not open or read the sidecar. An unreadable `sidecarPath` must not change that result. There is no field-by-field merge. Nested copies do not count as these own properties.

Otherwise, when `trade.evidence_ref` is a non-empty string, select sidecar records whose `trade_id` strictly equals that string. A valid record is one single-line JSON object with a string `trade_id` and own properties for all three evidence fields. Extra own properties do not invalidate a record. Evidence values may be `null` or any JSON value. Lines that fail this predicate are ignored. The last valid match in file order wins. No `evidence_ref`, a non-string `evidence_ref`, an empty-string `evidence_ref`, or no valid match returns absent evidence.

`externalizeTradeEvidence(trade, options)` appends one record and then returns the same trade object. It first validates that `trade.trade_id` is a non-empty string. It then constructs a separate record object without mutating `trade`, using `null` for each missing or `undefined` evidence field, and serializes that record before touching the sidecar or mutating `trade`. If validation or `JSON.stringify` fails, it throws without file or object mutation.

The record is one single-line `JSON.stringify` object containing exactly `trade_id`, `order_lifecycle`, `token_risk_scan`, and `simulated_execution`, followed by a newline. `trade_id` in that record is `trade.trade_id`. Create or append the sidecar, then fsync it. Only after the append and fsync both succeed, set `evidence_ref` to `trade.trade_id` and delete the three own evidence properties.

On a create, append, or fsync failure, throw, preserve the trade object exactly as it was before the call, and do not add, overwrite, or delete `evidence_ref` or any evidence property. A partial sidecar line may remain and must be ignored by the resolver.

The default filesystem append must keep a later successful record independently parseable. If the sidecar already exists, is non-empty, and does not end in a newline, write one separator newline before the new record as part of that append, then fsync once after the separator and the record. The separator is not an evidence record. A later `resolveTradeEvidence` of the new `trade_id` must return that new record even though the earlier fragment remains. This separator behavior belongs to the default append, not to a supplied `fileOps` override.

For deterministic verification only, `externalizeTradeEvidence` may receive `options.fileOps`, an object with synchronous `append(path, line)` and `fsync(path)` functions. When supplied, those functions replace the corresponding default append and fsync operations, including the separator logic, and must be called in that order. The appended `line` is the single JSON record plus its trailing newline. Trade mutation must occur only after both return successfully. Production behavior uses the module’s normal filesystem implementation. Tests using this override must still provide a temporary `sidecarPath`; the override may inspect or operate on that temporary path but must not access the repository sidecar.

A second call on an object that already has a non-empty string `evidence_ref` and has none of the three evidence own properties is a no-op and must not validate, serialize, open, append, fsync, or mutate anything. If any of those properties is present, the call is not a no-op. Callers must still externalize a persisted trade only once: one shared object inserted into both `closed_trades` and `action_history` is one call. Two copies that both still contain embedded evidence are two records and are not allowed for that paired persistence.

## Phase 1 - Sidecar Evidence Storage and Compatibility Resolver

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=scripts/tradeEvidence.js -->
<!-- pilot:touches=scripts/verifyTradeEvidence.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=package.json -->
<!-- runner:read=pipeline.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

- Add `scripts/tradeEvidence.js` implementing the contract above.
- Export `resolveTradeEvidence` from `pipeline.js` as the same function reference owned by the shared module. Keep `externalizeTradeEvidence` available from the shared module.
- Keep evidence fields on the trade while lifecycle and risk metadata are constructed and while `recordTradeEvent` or `recordOutcomeEvent` snapshot that same object. Do not move those record calls. Do not externalize training-event records themselves. Their current snapshots are already serialized before `openPosition` or `executeSell` returns, and they must still embed the evidence they embed today, not the later post-return lifecycle.
- Do not call `externalizeTradeEvidence` inside `openPosition` or `executeSell`. Both return with the three evidence own properties still present. Do not call it from `savePortfolio` or from any scan of loaded `closed_trades` or `action_history`. A loaded portfolio contains distinct copies of historical pairs; sweeping them would migrate history and append two records per pair.
- Externalize the newly created shared trade exactly once, on that object only, after its last assignment of its own `order_lifecycle`, `token_risk_scan`, or `simulated_execution`, and before any `savePortfolio` that can persist it. In-place externalization is sufficient for the object already held by `closed_trades` or `action_history`. The sidecar record must contain those final values, including a lifecycle attached again after `openPosition` or `executeSell` returns. Do not also externalize at an earlier assignment.
- Place that single call on each live path:
  - Manual sells: in `applyPendingManualActions`, after `executeSell` returns and before that function’s `savePortfolio`. There is no second lifecycle attach.
  - Hard sells: in the run-cycle sell loop, after `executeSell` returns and before the cycle save. There is no second lifecycle attach.
  - Harvest sells: after the post-return `attachPaperOrderLifecycle`, before the cycle save. Nested `paper_trade_ticket` assignment and `applyEvidenceMetadata` are not a substitute for that final call.
  - Rotation sells: after `executeSell` returns. Rotation buys: after the post-return `attachPaperOrderLifecycle`. Both happen before `executeRotation` returns and before the cycle save.
  - Paper buys: after the post-return `attachPaperOrderLifecycle`, before the cycle save.
  - Trend-sleeve buys and sells: inside `executeTrendSleeve`, after each `openPosition` or `executeSell` returns and before `executeTrendSleeve` returns. There is no second lifecycle attach. This covers the checkpoint save, the cycle-end save, and the trend-only save.
- Do not externalize transient candidate, position, training-event, or replay-only objects. Leave nested `paper_trade_ticket` evidence and position-level `token_risk_scan` in place. Do not change `evidence_refs` or `evidence_ref_count`.
- Treat externalization failure as failure of that trade’s persistence path: the thrown error must prevent `savePortfolio` from persisting that trade in sidecar-backed form. The failed trade object stays embedded.
- Add `scripts/verifyTradeEvidence.js`, importing the shared module rather than relying on live portfolio writes, covering:
  - Embedded historical evidence, including a partial embedded object, without a sidecar file.
  - Embedded evidence winning when `evidence_ref` is also present, including when `sidecarPath` is unreadable, without opening that path.
  - Sidecar resolution by `evidence_ref`, not by a differing `trade.trade_id`.
  - One append writing all four keys, with missing evidence stored as JSON `null`.
  - Validation and serialization occurring before file or object mutation.
  - Append occurring before fsync and trade mutation occurring only after both succeed, using the test-only file-operations override.
  - A non-string or empty `trade_id`, and an unserializable evidence value, throwing before any file or object mutation.
  - Simulated append and fsync failures each preserving the input trade exactly and not adding or changing `evidence_ref`.
  - Idempotent second externalization of an already externalized object without invoking file operations.
  - Missing file, unreadable path, missing reference, blank lines, malformed JSON, and well-formed non-record lines.
  - Duplicate `trade_id` lines resolving to the last valid record.
  - A temporary sidecar pre-seeded with a partial unterminated fragment, then a real default-filesystem externalize, still resolving the new record as its own line.
  - Null, undefined, and non-object trades returning absent evidence.
  - `pipeline.js` re-exporting the shared resolver reference.
- Add this verifier to the existing `npm run check` chain without broadening or replacing the configured suite.
- Override `sidecarPath` with a temporary file in every test. The partial-line case uses the default filesystem implementation and a temporary path, not `fileOps`.

### Acceptance Criteria

- New persisted buy and sell trade objects contain `evidence_ref` equal to their `trade_id` and do not have own properties named `order_lifecycle`, `token_risk_scan`, or `simulated_execution`.
- Each newly persisted trade produces exactly one sidecar record, written from the evidence values present after the last assignment above, even when the same object is represented in both reconciliation collections and even when lifecycle metadata is attached again after `openPosition` or `executeSell` returns.
- Historical embedded trade objects are not rewritten and resolve without requiring any sidecar file.
- Sidecar-backed trades resolve to the same three-field object shape as embedded records.
- Validation, serialization, append, or fsync failure cannot mutate the trade into a sidecar-backed state.
- A partial trailing fragment does not prevent a later successful record from resolving.
- Training-event snapshots taken before externalization still embed the evidence they embed today.
- No repository file under `logs/**` or `portfolio.json` is changed by implementation or verification.
- `npm install && npm run check` succeeds.

## Phase 2 - Migrate Trade Evidence Consumers

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=scripts/reconciliationAccounting.js -->
<!-- pilot:touches=scripts/signalAttribution.js -->
<!-- pilot:touches=scripts/tradeReviewer.js -->
<!-- pilot:touches=scripts/backtestReplay.js -->
<!-- pilot:touches=scripts/orderLifecycle.js -->
<!-- pilot:touches=scripts/operationsMonitor.js -->
<!-- pilot:touches=scripts/evidencePackets.js -->
<!-- pilot:touches=scripts/verifyTradeEvidence.js -->
<!-- runner:read=pipeline.js -->
<!-- runner:read=scripts/tradeEvidence.js -->
<!-- runner:read=scripts/verifyTradeEvidence.js -->
<!-- runner:read=package.json -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

- Import the shared module directly from every listed consumer. Do not import `pipeline.js` from those consumers for evidence resolution.
- Use `resolveTradeEvidence` whenever one of the three evidence fields is read from a persisted trade or action-history record.
- Pass no `sidecarPath` in production reads so every consumer uses the repository-root default.
- Update `server.js` trade lifecycle, execution, order ID, and risk decision projections to support both embedded and sidecar-backed records. Do not drop a trade only because the raw three evidence properties are absent. Keep the order-id and risk-decision projection and `summarizeExecutionSnapshot` pure. Do not satisfy this phase by calling an HTTP handler or `enrichSoldTrade`.
- Update `scripts/reconciliationAccounting.js` without changing its intentional cross-check between `closed_trades` and `action_history`. Paper-trade normalization must resolve before deciding that simulated execution or an order lifecycle is missing. Sidecar storage is not missing execution evidence.
- Update `scripts/signalAttribution.js` for both buy/open and sell/close action-history lookups, including liquidity bucket, lifecycle, strategy version, and simulated-execution derivation.
- Update `scripts/tradeReviewer.js` and `scripts/operationsMonitor.js` wherever their input is a persisted trade, including order-lifecycle collection from `action_history` and `closed_trades`.
- Update `scripts/evidencePackets.js` only at reads of a persisted trade’s own `token_risk_scan`. Candidate and position inputs that already have that own property keep today’s embedded value. Do not externalize packet inputs.
- Update `scripts/backtestReplay.js` only to the extent a portfolio-trade read uses the three top-level fields. Leave replay-generated transient event construction unchanged. Keep using nested `paper_trade_ticket.token_risk_scan` and the explicit resimulated execution. Do not prefer a resolved top-level scan over the nested ticket, and do not feed the portfolio trade’s stored execution into the replay fill.
- Update `scripts/orderLifecycle.js` so `input.execution`, when provided, remains the construction input and is not replaced by the resolver. When `input.execution` is absent, obtain `simulated_execution` through `resolveTradeEvidence`. During new trade construction the trade still has embedded evidence, so that fallback must not require a sidecar.
- If the pure persisted-trade evidence projection is not already exported, export that existing projection without changing its outputs for embedded records, and keep existing callers on that same function. Each such export accepts the same records it already accepts plus an optional trailing or nested `{ sidecarPath }` and forwards that path to `resolveTradeEvidence`. Do not add `sidecarPath` by overloading a field on the trade.
- The verifier must call those pure projections only. It must not call `runTradeReviewer`, `generateReconciliationAccountingReport`, `generateSignalAttributionReport`, `generateOperationsMonitorReport`, `runBacktestReplay`, or a server listener. Those entry points read the repository portfolio or logs, and some append under `logs/**` or write reports.
- Preserve existing fallback behavior for fields that are not the persisted trade’s own three evidence properties, including nested ticket copies and `evidence_refs`.
- Do not change report schemas, identifiers, accounting totals, attribution grouping, or dashboard response shapes.
- Extend `scripts/verifyTradeEvidence.js` rather than adding a script. Use a temporary sidecar, forwarded through `{ sidecarPath }`, and in-memory trades only.
  - For `server.js`, reconciliation, signal attribution, trade review, operations monitor, and evidence-packet scoring of a persisted trade: compare one embedded trade with an otherwise identical sidecar-backed trade. The discriminating evidence lives only on the embedded object or in the sidecar. The check must fail if that consumer still reads the three fields only from the raw persisted trade.
  - For `orderLifecycle.js`: compare `createOrderLifecycleRecord` without `input.execution` for that same pair, and assert that an explicit `input.execution` still wins for an embedded construction trade without reading the sidecar.
  - For `backtestReplay.js`: compare one embedded portfolio trade with a sidecar-backed twin through the pure replay-input projection. Nested-ticket risk inputs and the replay decision stay the same once top-level evidence has moved to the sidecar. Do not require those replay results to change based on sidecar contents.
- Wrap each trade in the minimal in-memory argument or collection shape that the pure export expects.

### Acceptance Criteria

- Every consumer that derives results from persisted-trade evidence produces equivalent evidence-derived results for an embedded trade and an otherwise identical sidecar-backed trade, and the extended verifier demonstrates that equivalence without reading or writing `portfolio.json` or `logs/**`.
- Signal attribution resolves evidence for both sides of a completed position and no longer depends on raw evidence fields being present in `action_history`.
- Reconciliation still detects missing links between `closed_trades` and `action_history` and does not interpret sidecar storage as missing execution evidence.
- Explicit construction and replay execution inputs still bypass the sidecar. Nested ticket copies still drive replay risk inputs.
- Direct evidence-field access remains only in construction, replay transient-event construction, nested-copy fallbacks, and the shared resolver. Report-time normalization of a persisted trade is not one of those exceptions.
- Read-only consumers treat absent resolver evidence as the existing missing-evidence fallback and do not terminate the report or server request.
- No protected path is modified.
- `npm install && npm run check` succeeds.
