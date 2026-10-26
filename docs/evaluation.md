# Evaluation tools

Three offline, read-only tools for judging whether the desk adds value and whether a
parameter change helped. None of them place orders, touch the network or change any
trading decision. Each one runs on a synthetic fixture with `--fixture=null` (no edge)
or `--fixture=edge` (planted edge), so you can see the output before real data exists.

## 1. Point-in-time candidate snapshots

Each pipeline cycle appends to `logs/candidate-snapshots.jsonl` (gitignored):

- one `cycle` record: cycle id, time, regime, settings hash, ETH price, counts per stage;
- one `candidate` record per token the cycle looked at, with the furthest `stage` it
  reached (`universe_blocked`, `ranked_out`, `shortlisted`, `desk_filtered`,
  `price_rejected`, `gate_rejected`, `risk_vetoed`, `approved`, `bought`), reason codes
  and the fields the gate sees (price, liquidity, market cap, 24h volume, slippage
  estimate, fraud risk, fragility, confidence, evidence count);
- `price_marks` records: up to 500 token-universe prices, so later cycles can price
  exits for tokens the desk did not buy.

New settings versions are written once to `logs/settings-ledger.jsonl`. The hook runs
after the cycle's trades are final, inside its own try/catch. A logging failure is logged
as `candidate_snapshot_error` and never affects the cycle. Records hold no wallet, cash,
quantity or PnL fields, and each is capped at 8 KB.

`npm run eval:snapshots` (`scripts/snapshotCompleteness.js`) reports the share of cycles
(`cycle_start` events) that have a snapshot, overall and since the first snapshot. Use the
second figure. Aim for close to 100%: missing cycles are usually cycles that aborted.

## 2. Baseline comparison

`npm run eval:baselines -- [--from=ISO] [--to=ISO] [--seed=42] [--draws=1000] [--universe=gate|all]`

This compares the system's closed trades (from `logs/training-events.jsonl`) with these
baselines, all net of the paper fill model (fees plus liquidity-bucket slippage, mirrored
from `pipeline.js` in `scripts/evalCostModel.js`):

- **(a) ETH**: ETH bought at each trade's entry and sold at its exit (paired). The
  window buy-and-hold figure is also shown for reference.
- **(b) equal-weight approved**: every approved candidate, held for the median system
  holding time.
- **(c) random entry**: for each system trade, a random candidate from the same cycle's
  gated universe (`--universe=all` uses every candidate), with the same holding time.
  1000 seeded draws.
- **(d) system**: the actual trades.

How to read it:

- `excess` is the system's mean net return per entry minus the baseline's. `CI95` is a
  bootstrap 95% interval. Treat the result as evidence only when the interval
  excludes 0.
- `p` (random entry only) is the share of random draws that did at least as well as
  the system.
- Below **100 entries or 30 distinct entry days**, the verdict is `INSUFFICIENT DATA`
  with the shortfall. A large excess on a small sample is not evidence (the 12-day
  fixture shows a tight-looking interval that is still flagged).
- Baselines use a simplified exit rule: a fixed stop at `default_stop_distance_pct`, a
  partial sale at the first target, and a time exit. Trailing, ATR and harvest exits
  are not modelled, so (b) and (c) test entry selection, not exit skill.
- Trend-sleeve WETH trades are excluded unless you pass `--include-trend-sleeve`.

## 3. Settings hash and ledger

The effective settings (`SETTINGS_DEFAULTS` plus portfolio overrides) are hashed
(`sh1:<16 hex>`, independent of key order). The hash is stamped on new snapshot records
and, as an added `settings_hash` field, on new buy and sell trade records.

`npm run eval:settings` (`scripts/settingsLedger.js`) lists each settings version: when
it was active, how many cycles it ran, which keys changed from the previous version, and
its closed-trade count, expectancy (USD and mean net return) and win rate. Closed
positions count toward the version active at entry. Trades from before this field
existed are grouped as `unhashed`.

## The tuning rule

A tuning change (a PR that changes a setting, gate threshold or exit rule) must:

1. **Name its metric** before the change, for example "mean net return per entry vs
   random entry" or "expectancy per closed trade".
2. **Be judged on a period it was not tuned on**: the trades under the new settings hash
   after the change, not the incident or window that motivated it.
3. **Clear the data bar**: at least 100 entries over at least 30 distinct days under the
   new hash, with a 95% interval that excludes 0. Until then the change is
   unvalidated, however good one incident looks.

## Running on history (backfill)

The snapshot hook only records cycles from the day it was deployed. To evaluate the
months before that, rebuild snapshots from `logs/training-events.jsonl`:

```
npm run eval:backfill            # writes logs/candidate-snapshots.backfilled.jsonl
                                 # and logs/settings-ledger.backfilled.jsonl
npm run eval:baselines -- --include-backfilled --drop-price-spikes
npm run eval:settings  -- --include-backfilled
npm run eval:snapshots -- --include-backfilled
```

`scripts/backfillSnapshots.js` streams the training events (read-only) and writes new
files; it refuses to overwrite an existing output without `--force` and refuses to
write over its input or the live snapshot files. Use `--input=`, `--out=` and
`--ledger-out=` to work on a copy elsewhere, and `--backfilled-snapshots=PATH` /
`--backfilled-ledger=PATH` to point the tools at it. Every record it writes has
`provenance: "backfilled"`; the tools only read these files when asked, label the
output (`DATA: backfilled` / `live+backfilled`, `[backfilled]` versions, a separate
`BACKFILLED` completeness section) and prefer live records for any cycle that has both.
Run each tool with and without the flag to see what the backfill adds.

What the backfill can and cannot rebuild:

| Snapshot content | Source in history | Backfilled? |
| --- | --- | --- |
| cycle time, regime | `cycle_start` | yes |
| settings hash | `cycle_start.payload.settings` | partly: `bf1:` hash of the logged portfolio overrides, not the effective defaults merge |
| ETH price | WETH price mark in the same cycle | only in cycles that held WETH; otherwise null |
| gate_rejected / risk_vetoed / approved | `risk_decision` (buy proposals) | yes, with the proposal's confidence, evidence count, fragility |
| bought | `trade` buy legs | yes |
| price, liquidity, mcap, volume, slippage, fraud | `candidate` and `risk_decision` | yes where logged, null otherwise |
| desk-kept but no risk decision | `candidate` only | stage `price_rejected`, reason `backfill_no_risk_decision` |
| universe_blocked / ranked_out / shortlisted / desk_filtered | not in training events | no |
| price marks | held positions and market-trend lists in `cycle_start` / `cycle_end` | yes (trade fill prices are not used) |

Caveats when reading results on backfilled history:

- **Random entry has little power**: the backfilled gated universe is only the
  candidates that reached the risk reviewer (often one or two per cycle, frequently the
  one that was bought), so (c) mostly compares the system's real exits with the
  simplified exit rule on the same tokens.
- **Survivorship**: candidates are priced later only when the token shows up again
  (held, re-proposed or in a trend list). Tokens that vanished are unpriceable and drop
  out of (b) and (c), which flatters the baselines.
- **Price glitches**: history mixes price feeds and has occasional unit errors (orders
  of magnitude). `--drop-price-spikes[=10]` drops isolated points more than 10x away
  from both neighbours; check results with and without it.
- **ETH** is only priced while the desk held WETH, so (a) is usually short of data.
- **Settings churn**: `bf1:` versions only see the logged overrides; code-default
  changes in `pipeline.js` (see `git log -L '/const SETTINGS_DEFAULTS = {/,/^};/:pipeline.js'`)
  are invisible to them. Split by date with `--from` / `--to` around known changes.
- **Paper-fill model**: historical trades carry the PnL of the fill model active at
  the time (the liquidity-scaled sell slippage with a 400 bps unknown-liquidity default
  arrived on 2026-09-29), while baselines use the current model.
