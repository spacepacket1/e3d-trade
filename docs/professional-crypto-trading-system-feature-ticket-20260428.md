# Professional Crypto Trading System — Feature Ticket

## 1. Summary

Upgrade the E3D Agent Trading Floor from a paper-trading research loop into a professional-grade crypto trading system.

The current system has useful agent orchestration, paper portfolio accounting, performance scorecards, trade reviews, dashboard visibility, and basic buy-blocking risk controls. It is not yet a professional trading system because it has not proven durable edge, does not replay strategies against historical market conditions, does not model execution realistically, and does not have production-grade operational, custody, venue, and risk controls.

This ticket defines the applied crypto trading features needed to make the system suitable for disciplined paper trading, shadow trading, and eventually tightly controlled live trading.

## 2. Goals

### 2.1 Product goals

- Make the dashboard able to answer whether the system is profitable, robust, safe, and improving.
- Turn every agent decision, trade, fill, rejection, and portfolio mutation into auditable structured data.
- Add promotion gates so a strategy cannot move from paper to live without evidence.
- Provide operator controls to pause, unwind, disable buys, and inspect risk quickly.

### 2.2 Trading goals

- Prove or reject strategy edge with historical replay and out-of-sample validation.
- Reduce negative expectancy setups before they reach execution.
- Improve fill realism and execution quality measurement.
- Cap daily losses, drawdowns, token exposure, venue exposure, and strategy exposure.
- Make no-trade decisions explicit and rewarded when conditions are poor.

### 2.3 Engineering goals

- Preserve the existing principle: AI suggests, deterministic code decides.
- Keep live trading disabled until all phase gates pass.
- Prefer modular, observable components over hidden agent behavior.
- Keep paper-trading behavior reproducible from logs and snapshots.

## 3. Non-Goals

- Do not enable unrestricted live trading.
- Do not custody user funds as part of this feature.
- Do not implement high-frequency trading.
- Do not add leverage, margin, perps, options, or borrowing in the first version.
- Do not allow LLM-only trade approval.
- Do not optimize for raw trade count.

## 4. System Principles

- Every order must have a strategy version, signal snapshot, risk decision, sizing decision, execution plan, and post-trade review.
- Every live-capable action must pass pre-trade risk checks.
- Every strategy must support replay before promotion.
- Every external data source must have freshness and quality metadata.
- Every kill switch must fail closed.
- Every trading mode must be explicit: `research`, `paper`, `shadow`, `tiny_live`, `scaled_live`.

## 5. Proposed Capability Map

Required new capabilities:

1. Historical replay and backtesting.
2. Walk-forward validation and strategy promotion gates.
3. Execution simulation and execution-quality analytics.
4. Order lifecycle management.
5. Portfolio and strategy risk engine.
6. Crypto venue, wallet, custody, and key-management controls.
7. Token and smart-contract risk scanner.
8. Liquidity, routing, MEV, and gas-aware execution controls.
9. Data quality and market data normalization.
10. Signal attribution and expectancy analytics.
11. Operations, monitoring, alerting, and incident review.
12. Reconciliation, accounting, and tax-lot exports.
13. Compliance-style audit trail and operator permissions.
14. Professional dashboard upgrades.

## 6. Phase 1 — Historical Replay and Backtesting

### 6.1 Description

Add a replay engine that can run the current candidate, risk, sizing, and execution logic against historical market snapshots without mutating the live paper portfolio.

### 6.2 Requirements

- Create immutable market snapshots from available E3D data, token prices, stories, liquidity, and portfolio state.
- Replay strategy decisions at fixed cycle intervals.
- Support deterministic seeds and strategy versions.
- Produce a replay portfolio independent from `portfolio.json`.
- Record all simulated decisions and simulated fills.
- Support benchmark comparisons:
  - cash only
  - buy-and-hold ETH
  - equal-weight eligible universe
  - current live paper strategy

### 6.3 Metrics

- CAGR-style return for the replay window, if applicable.
- Total return.
- Realized PnL.
- Unrealized PnL.
- Profit factor.
- Sharpe-like and Sortino-like ratios using replay returns.
- Maximum drawdown.
- Win rate.
- Average win/loss.
- Turnover.
- Fee drag.
- Slippage drag.
- Exposure by token, category, signal, and strategy version.

### 6.4 Outputs

```text
reports/backtests/backtest-YYYYMMDD-HHMMSS.json
reports/backtests/backtest-YYYYMMDD-HHMMSS.md
logs/backtest-events.jsonl
```

### 6.5 Acceptance Criteria

- Backtest can run without touching `portfolio.json`.
- Same inputs and strategy version produce identical outputs.
- Replay report includes performance versus at least two baselines.
- Strategy changes can be compared before and after.

## 7. Phase 2 — Walk-Forward Validation and Promotion Gates

### 7.1 Description

Add evidence gates that determine whether a strategy can move from research to paper, shadow, tiny live, or scaled live.

### 7.2 Requirements

- Split tests into train, validation, and out-of-sample windows.
- Run rolling walk-forward validation.
- Detect overfitting:
  - performance concentrated in one day
  - performance concentrated in one token
  - performance from one large outlier
  - high turnover with fee-sensitive edge
  - positive win rate but negative expectancy
- Require minimum sample sizes per strategy and setup.
- Track strategy version lineage.

### 7.3 Promotion States

- `research`: backtest only.
- `paper`: simulated portfolio only.
- `shadow`: live market data and live order plans, no submitted orders.
- `tiny_live`: live orders under strict notional caps.
- `scaled_live`: live orders under production limits.

### 7.4 Acceptance Criteria

- No strategy can promote without a signed promotion report.
- Promotion report includes sample size, drawdown, profit factor, expectancy, and known weaknesses.
- Regression test fails if a strategy is promoted while blockers remain.

## 8. Phase 3 — Execution Simulation and Quality Analytics

### 8.1 Description

Replace simplistic paper fills with realistic crypto execution simulation.

### 8.2 Requirements

- Model spread, fees, slippage, liquidity depth, and market impact.
- Model partial fills and failed fills.
- Support CEX-style order books and DEX pool quotes.
- Compare intended price, quoted price, simulated fill price, and final mark price.
- Track execution quality by venue, token, order type, size, time of day, and liquidity bucket.

### 8.3 Metrics

- Arrival price.
- Decision price.
- Quote price.
- Fill price.
- Slippage bps.
- Fee bps.
- Price improvement or price degradation.
- Fill ratio.
- Rejection ratio.
- Time to fill.
- Post-fill adverse movement.

### 8.4 Acceptance Criteria

- Paper trade records include explicit simulated fill details.
- Dashboard shows slippage and fee drag.
- Strategy performance can be viewed before and after execution costs.

## 9. Phase 4 — Order Lifecycle Management

### 9.1 Description

Create an order-management layer that can represent paper, shadow, and future live orders using the same state machine.

### 9.2 Order States

- `planned`
- `risk_rejected`
- `approved`
- `submitted`
- `acknowledged`
- `partially_filled`
- `filled`
- `cancel_requested`
- `canceled`
- `expired`
- `rejected`
- `failed`

### 9.3 Requirements

- Add stable order IDs separate from trade IDs.
- Link orders to strategy version, agent decisions, risk checks, and portfolio mutation.
- Support idempotent order submission.
- Store venue response payloads.
- Prevent duplicate order submission after process restart.
- Support cancel and replace.

### 9.4 Acceptance Criteria

- Every trade must derive from one or more orders.
- Every order has a complete lifecycle log.
- Re-running the process cannot duplicate a submitted order.

## 10. Phase 5 — Portfolio and Strategy Risk Engine

### 10.1 Description

Add a deterministic risk engine that evaluates portfolio-level and strategy-level risk before any order can be approved.

### 10.2 Required Controls

- Daily realized loss limit.
- Daily total equity drawdown limit.
- Rolling 24h loss limit.
- Maximum position size.
- Maximum token exposure.
- Maximum category exposure.
- Maximum venue exposure.
- Maximum wallet exposure.
- Maximum strategy exposure.
- Maximum open positions.
- Maximum daily turnover.
- Cooldown after stop loss.
- Cooldown after strategy-level loss cluster.
- New-buy block during negative expectancy regimes.
- Minimum liquidity and volume thresholds.
- Maximum spread and slippage thresholds.
- Stablecoin depeg block.
- Market-wide risk-off block.

### 10.3 Kill Switches

- `disable_new_buys`
- `disable_rotations`
- `exit_only`
- `cancel_open_orders`
- `pause_all_trading`
- `force_shadow_mode`

### 10.4 Acceptance Criteria

- Risk engine produces structured allow/block decisions.
- Every block reason is visible in logs and dashboard.
- New buys are blocked when configured loss limits are breached.
- Exits remain available unless explicitly paused.

## 11. Phase 6 — Venue, Wallet, Custody, and Key Controls

### 11.1 Description

Add crypto-specific operational controls for exchanges, wallets, and signing.

### 11.2 Venue Requirements

- Venue registry:
  - CEX
  - DEX
  - aggregator
  - bridge
- API health status.
- Withdrawal/deposit status.
- Known incident status.
- Per-venue exposure limit.
- Per-venue order size limit.
- Per-venue rate-limit tracking.
- Venue disable switch.

### 11.3 Wallet and Key Requirements

- Separate hot wallet, warm wallet, and cold wallet concepts.
- Never store raw private keys in repo files.
- Support external signer or environment-injected credentials.
- Require explicit signing policy per mode.
- Enforce maximum transaction value per signer.
- Log transaction hashes and signing request metadata.
- Support nonce tracking and stuck transaction handling.

### 11.4 Acceptance Criteria

- Trading cannot run live without configured venue and wallet policies.
- Missing key policy fails closed.
- Dashboard shows venue health and wallet exposure.

## 12. Phase 7 — Token and Smart-Contract Risk Scanner

### 12.1 Description

Add a deterministic scanner for token-level hazards before Scout or Risk can approve a trade.

### 12.2 Checks

- Honeypot behavior.
- Buy tax and sell tax.
- Transfer restrictions.
- Blacklist or whitelist functions.
- Pausable contract.
- Proxy upgradeability.
- Mint authority.
- Owner concentration.
- Holder concentration.
- Liquidity lock status.
- Liquidity pool concentration.
- Recent deploy age.
- Verified source status where available.
- Known scam lists.
- Symbol/name spoofing.
- Wrapped asset and bridge asset mapping.

### 12.3 Acceptance Criteria

- Risk rejects tokens with critical contract hazards.
- Scanner output is stored with every candidate.
- Dashboard shows top token-risk blockers.

## 13. Phase 8 — Liquidity, Routing, Gas, and MEV Controls

### 13.1 Description

Add execution controls specific to DEX and on-chain trading.

### 13.2 Requirements

- Estimate gas before order approval.
- Estimate price impact from pool depth.
- Detect thin or single-pool liquidity.
- Compare routes across approved venues or aggregators.
- Enforce max slippage.
- Enforce max gas cost as a percentage of trade notional.
- Detect likely sandwich/MEV exposure.
- Support private transaction route setting where available.
- Reject bridge-dependent execution in the first live phase.

### 13.3 Acceptance Criteria

- DEX orders cannot be approved without gas, route, and price-impact estimates.
- Execution plan includes expected amount out, minimum amount out, gas estimate, and route.
- MEV-sensitive trades are blocked or forced to shadow mode.

## 14. Phase 9 — Data Quality and Market Data Normalization

### 14.1 Description

Build a normalized data layer that tags every market datum with source, timestamp, freshness, and confidence.

### 14.2 Requirements

- Normalize token identifiers by chain and contract address.
- Track source freshness.
- Detect stale prices.
- Detect large cross-source price disagreement.
- Detect missing liquidity.
- Detect suspicious volume spikes.
- Record API errors and degraded data mode.
- Provide fallback hierarchy by data type.

### 14.3 Acceptance Criteria

- Scout and Risk receive data-quality flags.
- Candidates with stale or conflicting data are blocked or down-ranked.
- Dashboard shows data-source health.

## 15. Phase 10 — Signal Attribution and Expectancy Analytics

### 15.1 Description

Measure which signals and setups actually produce positive expectancy.

### 15.2 Requirements

- Attribute each trade to:
  - strategy version
  - setup type
  - story type
  - source agent
  - token category
  - liquidity bucket
  - market regime
  - entry signal set
  - exit signal set
- Compute expectancy by group.
- Identify negative expectancy groups.
- Feed negative expectancy groups into buy blocking and sizing reductions.
- Distinguish no-trade decisions from missed opportunities.

### 15.3 Acceptance Criteria

- Dashboard shows best and worst setups by expectancy.
- Risk engine can block a setup with repeated negative expectancy.
- Reports distinguish high win rate from positive expectancy.

## 16. Phase 11 — Operations, Monitoring, Alerts, and Incidents

### 16.1 Description

Add production operations for a 24/7 crypto market.

### 16.2 Requirements

- Process supervisor status.
- Pipeline heartbeat.
- Dashboard server heartbeat.
- Last successful cycle timestamp.
- Data-source health.
- Venue health.
- Wallet signer health.
- Order queue health.
- Alert rules:
  - trading loop stopped
  - daily loss limit breached
  - drawdown limit breached
  - new-buy block activated
  - stale market data
  - order rejected or stuck
  - reconciliation mismatch
  - API credentials missing or invalid
- Incident log with severity, start time, end time, root cause, and remediation.

### 16.3 Acceptance Criteria

- Operator can see whether the system is trading, paused, degraded, or failed.
- Alerts are emitted as structured events even before external notification integrations exist.
- Incident reports can be generated from logs.

## 17. Phase 12 — Reconciliation, Accounting, and Tax-Lot Exports

### 17.1 Description

Add reconciliation between internal portfolio state and external balances/fills.

### 17.2 Requirements

- Reconcile:
  - internal portfolio
  - exchange balances
  - wallet balances
  - open orders
  - fills
  - fees
  - gas
  - transfers
- Track lots using FIFO by default.
- Export realized gains, fees, transfers, and lots.
- Distinguish trade, transfer, staking, airdrop, reward, and fee events.

### 17.3 Acceptance Criteria

- Reconciliation mismatch blocks live trading.
- Daily reconciliation report is generated.
- Tax-lot export is available as CSV and JSON.

## 18. Phase 13 — Audit Trail, Permissions, and Operator Controls

### 18.1 Description

Add compliance-style controls even if the system is not a regulated broker-dealer.

### 18.2 Requirements

- Immutable decision logs.
- Strategy version signatures.
- Operator actions log.
- Role-based permissions:
  - viewer
  - operator
  - risk_admin
  - deploy_admin
- Manual approvals for mode promotion.
- Manual approvals for live-capable strategy changes.
- Reason-required overrides.

### 18.3 Acceptance Criteria

- Every manual action has actor, timestamp, reason, and previous/new state.
- Live mode cannot be enabled without approval record.
- Dashboard exposes current permissions and mode.

## 19. Phase 14 — Professional Dashboard Upgrades

### 19.1 Description

Upgrade the dashboard from activity monitoring to trading operations.

### 19.2 Views

- Performance:
  - PnL
  - profit factor
  - drawdown
  - fee/slippage drag
  - benchmark comparison
- Risk:
  - active kill switches
  - limit utilization
  - blocked reasons
  - exposure by token, category, venue, wallet, and strategy
- Strategy:
  - strategy versions
  - promotion state
  - backtest results
  - walk-forward results
  - expectancy by setup
- Execution:
  - order lifecycle
  - fills
  - slippage
  - failed/rejected orders
- Crypto Ops:
  - venue health
  - wallet exposure
  - signer health
  - gas state
  - reconciliation status
- Incidents:
  - active incidents
  - resolved incidents
  - root cause summaries

### 19.3 Acceptance Criteria

- Operator can answer "Can this system trade right now?" in one screen.
- Operator can see why buys are blocked.
- Operator can see whether strategy edge survives fees and slippage.

## 20. Recommended Implementation Order

1. Backtest/replay harness.
2. Strategy versioning and promotion gates.
3. Execution simulation with fees/slippage.
4. Portfolio risk engine and kill switches.
5. Data quality layer.
6. Signal attribution and expectancy analytics.
7. Token/smart-contract risk scanner.
8. Venue and wallet policy registry.
9. Order lifecycle manager.
10. Reconciliation reports.
11. Operations alerts and incident logs.
12. Dashboard upgrades.
13. Shadow trading mode.
14. Tiny live mode behind approvals.

## 21. Definition of Professional-Grade for This Repo

The system should not be considered professional-grade until all of the following are true:

- A strategy can be replayed historically with deterministic results.
- A strategy has passed walk-forward validation.
- Live trading is blocked by default.
- All live-capable orders pass deterministic risk checks.
- All fills include realistic fees and slippage.
- All positions reconcile against external balances.
- All token entries pass smart-contract and liquidity checks.
- All venues and wallets have explicit risk limits.
- Operators can pause trading immediately.
- The dashboard shows current mode, risk state, health state, and active blockers.
- Strategy changes are versioned and auditable.
- The system can prove positive expectancy after costs, not just high win rate.

## 22. Open Questions

- Which live venues should be supported first: CEX, DEX, or shadow-only aggregator quotes?
- Which chains should be allowed in the first live-capable phase?
- What is the maximum acceptable daily loss in paper, shadow, and tiny-live modes?
- What external signer or wallet policy should be used?
- Should bridges be permanently disallowed or only disallowed in early phases?
- What minimum backtest sample size is required before tiny-live promotion?
- What notification channel should receive critical alerts?

