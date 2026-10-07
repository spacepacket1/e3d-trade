# Live Execution Engine — Specification

## 1. Purpose

`e3d-agent-trading-pipeline-spec.md` describes the paper-trading pipeline: Scout → Harvest → Risk → Executor → Manager, deterministic accounting, "AI suggests, code decides," paper mode as the default. This document specifies **Live Mode**: an unattended execution path that submits real on-chain swaps with real capital, while leaving Scout, Harvest, Risk, Manager, and portfolio accounting unchanged.

Goal: make money with an automated system. The capital at risk is deliberately small and enforced in code (§8).

E3DToken is the accounting and brand unit, not the swap medium. Its on-chain liquidity is far too thin to route trades through without moving its own price (checked 2026-10-06: $11.6k total, ~$5.8k effective, $0 24h volume). Trades settle in WETH. P&L is also reported in E3D-equivalent terms as a ledger convention; no execution logic depends on it.

**Non-goals for v1:** outside capital, multi-user accounts, Coinbase or MetaMask integration, an L2 path (planned after v1), and any change to Scout/Harvest/Risk/Manager logic or to paper mode's default.

## 2. Design principles

- **AI suggests, code decides.** No LLM-driven code path holds signing authority or constructs a transaction. Only the executor (§5) signs or submits, and only after the caps in §8 pass.
- **Paper mode remains the default.** Live mode is opt-in per process, never implied by a settings value an LLM output could influence.
- **Caps live outside the LLM path.** Risk's caps are downstream of LLM output. Live caps are enforced inside the executor, where no upstream code can override them.
- **Balances come from the chain, not the quote.** 0x's balance and allowance checks reflect mainnet state. The executor reads its own balances and allowances from its provider, so it behaves the same on a fork and in production.

## 3. Where things run

- **Signer and trading process:** this Mac, as its own pm2 process (`e3d-trade-live-pipeline`) with its own portfolio file (`portfolio.live.json`). Paper pipelines are untouched.
- **Chain reads and balance checks:** Infura (Ethereum mainnet JSON-RPC). Balances, allowances, gas fees, nonces, and receipt polling. The Ethereum node at 192.168.8.187 is not reachable from this Mac and is not used by the live path.
- **Transaction submission:** Flashbots Protect RPC (`https://rpc.flashbots.net`, `eth_sendRawTransaction`). Signed swaps go to the private relay and aren't visible in the public mempool. The relay only includes transactions that don't revert, so failed swaps don't cost gas. It can hold a transaction for up to 25 blocks, so the receipt timeout matters.
- **Routing:** 0x Swap API, AllowanceHolder flow (`/swap/allowance-holder/quote`). The quote returns transaction data and the approval target; no signing of typed data is needed.
- **The stories/theses box (192.168.8.187 network, 10.0.0.233 host)** runs the buildDB pipeline that feeds e3d.ai. It is not part of the trading path.
- **Venue:** on-chain only. A headless signer can't run in MetaMask or Coinbase Wallet, so it needs a key the software can use.

## 4. Capital and custody

- **Hot wallet:** an Ethereum EOA, `0xCFB5da71cE340E06a280Df30a9aeF54d7f8Ba907` (public, generated 2026-10-06 on this Mac). Holds WETH for trading and ETH for gas. This is the only key the trading process can use.
- **Key storage:** an encrypted Foundry keystore at `~/.config/e3d-trade/keystore/hot-wallet`, outside the repo. Its password is in `~/.config/e3d-trade/hot-wallet.pass`, readable only by the trading user. Neither the key nor the password is in env vars, logs, or chat. The Infura and 0x API keys are secrets too and live in the gitignored `.env`.
- **Key backup:** the keystore file goes to the owner's laptop, not synced to any cloud service. The keystore password is written on paper and kept offline, separate from the keystore, so the laptop copy alone can't sign.
- **Hot wallet ceiling:** **$1,000.** The signer refuses to buy above this and flags any excess for sweeping to a treasury wallet the pipeline never holds a key for.
- **Gas reserve:** **$50** of ETH, converted to USD at runtime. The signer refuses to buy if the trade would drop ETH below this. Sells may use the reserve, because an exit needs gas.

The ceiling is enforced in code, not only by how much WETH you deposit. Top-ups and winning trades both grow the balance.

## 5. The fill-execution contract

`buildPaperFillExecution(trade)` in `pipeline.js` returns the fill shape that `executeSell`, `openPosition`, the trade ledger, and Manager evaluation consume:

```js
{
  model_version, decision, rejection_reason, side,
  arrival_price, decision_price, quote_price,
  simulated_fill_price, fill_price,
  requested_notional_usd, requested_quantity,
  filled_notional_usd, quantity,
  fill_ratio, rejection_ratio,
  fee_bps, slippage_bps, fee_usd, slippage_usd,
  time_to_fill_ms,
  execution_control_id, quote_id, liquidity_execution_control
}
```

The live executor (`scripts/liveExecutor.js`) returns the fields the ledger needs from a real transaction: `decision`, `rejection_reason`, `side`, `requested_notional_usd`, `filled_notional_usd`, `quantity`, `quote_price`, `fill_price`, `slippage_bps`, `fee_usd`, `tx_hash`, `approval_tx_hash`, and `gas_used`. The paper-only fields (`execution_control_id`, `quote_id`, `liquidity_execution_control`) are not produced by live fills, and the mapping into the existing ledger is not yet wired (§10).

**Rejection reasons:** `live_execution_not_enabled`, `halted`, `circuit_breaker_open`, `invalid_notional`, `insufficient_liquidity`, `insufficient_balance`, `cap_exceeded_per_trade`, `cap_exceeded_per_day`, `hot_wallet_ceiling`, `gas_cap_exceeded`, `gas_reserve_breached`, `tx_submit_failed`, `tx_timeout`, `tx_reverted`.

## 6. Swap path

- **Library:** `ethers` v6. It decrypts the Foundry keystore directly, which `viem` can't do, and handles signing and receipts.
- **Quote:** 0x AllowanceHolder quote. The quote gives the buy amount, minimum buy amount, the approval target, the transaction to sign, and 0x's fee (0.15% on selected buy tokens, per the free tier). The 0x free tier's current rate limits haven't been confirmed.
- **USD valuation:** the ETH price is derived from a 0x quote of 1 WETH to USDC at trade time. Every notional, gas, and wallet value is converted with that rate.
- **Approval:** if the wallet's on-chain allowance to the AllowanceHolder contract is below the sell amount, the executor sends an exact-amount ERC-20 approval and waits for its receipt. The approval's gas counts toward the buy's gas cap.
- **Gas cap check:** before any approval, the executor compares the estimated gas cost with `max_gas_cost_per_buy_usd`. After populating the swap transaction, it compares the worst-case cost (gas limit × max fee per gas) with the same cap.
- **Submission:** the swap is signed locally and broadcast through the Flashbots Protect RPC. The approval is broadcast through Infura.
- **Receipt and timeout:** the executor waits for a receipt up to 300 seconds. A timeout returns `tx_timeout` and counts as a failure. The executor never automatically retries a trade whose on-chain state is uncertain.
- **Reconciliation:** after the receipt, the executor reads the sell-token and buy-token balances and computes the fill from the balance changes, not from the quote. Slippage is the difference between the quoted buy amount and what actually arrived.
- **Nonce:** `ethers` populates the nonce from the pending count. The live process runs one cycle at a time. A `flock` guard against a double start is part of the pm2 wrapper (not yet built).

## 7. Trading decisions

Scout, Harvest, Risk, and the deterministic portfolio engine produce buy, sell, and rotation actions exactly as in paper mode. Live mode changes only how those actions are filled. Actions that clear the caps in §8 execute automatically, with no approval step.

## 8. Safety rails

A `LIVE_CAPS` config in `scripts/liveCaps.js`, checked inside the executor:

| Cap | Value |
|---|---|
| Hot wallet ceiling | $1,000 |
| Max USD per buy | $100 |
| Max USD per day (buys) | $300 |
| Gas reserve (ETH) | $50 |
| Max gas cost per buy | $5. Sells exempt (confirmed by owner) |
| Circuit breaker | 3 consecutive failures (revert, timeout, or submit failure) |

Also:

- **Enable flag:** the executor refuses to run unless `LIVE_EXECUTION_ENABLED=1`. Nothing sets it until the go-live step (§9), so running the executor by hand can't trade real funds by accident.
- **Kill switch:** `LIVE_TRADING_HALT=1` stops buys and sells immediately, with no deploy needed.
- **Circuit breaker:** once tripped, buys are refused until the failure counter is reset. Sells are still allowed.
- **Caps are config, not LLM output.** Nothing in Scout, Risk, or the candidate pipeline can change them.
- **State:** the daily buy total and failure counter are kept in `~/.config/e3d-trade/live-state.json`, resetting at the UTC day boundary.

## 9. Build status and rollout

**Built and tested on an anvil mainnet fork (7 checks passing, 2026-10-06):**
- Caps, kill switch, circuit breaker, and gas cap logic: `scripts/liveCaps.js`, `scripts/verifyLiveCaps.js` (offline, in `npm run check`).
- 0x quote client: `scripts/liveQuote.js`, `scripts/verifyLiveQuote.js` (offline, in `npm run check`).
- Executor: `scripts/liveExecutor.js`, tested by `scripts/verifyLiveExecutorFork.js`. This is network-dependent (anvil plus Infura), so it runs by hand and is not in `npm run check`. It covers the enable flag, halt, per-trade cap, a buy with approval and reconciliation, a sell, the circuit breaker, and the daily cap.

**Not yet built or tested:**
- Flashbots Protect submission. The fork tests broadcast to anvil, not to the relay.
- Reverts and timeouts on real transactions. The circuit-breaker test sets the failure counter directly rather than causing a real revert.
- The pm2 process, the `flock` guard, and the mapping from live fills into the portfolio ledger.
- The go-live change: setting `LIVE_EXECUTION_ENABLED` for the live process and lifting the `custodyControls.js` Phase 6 block.

**Rollout:**
1. Finish the items above, still with the enable flag off.
2. Deposit the first WETH amount well below the $1,000 ceiling, and fund ETH for gas. Keep the flag off.
3. Turn the flag on and the Phase 6 block off in one reviewed change. Run unattended. Review fills and reconciliation daily for the first week.
4. Raise toward the ceiling only if the fills match the quotes and no caps are breached.

## 10. Decisions and open items

**Decided**
- Gas reserve: $50. Gas cap: $5 per buy, sells exempt.
- Routing: 0x, AllowanceHolder flow. Free tier with 0.15% fee on selected buy tokens.
- Venue: Ethereum mainnet only. L2 path after v1. No Coinbase or Kraken.
- Key backup: keystore to the owner's laptop, password on paper, kept separate.
- Policy exception, authorized by the owner: unattended on-chain trading by the live signer is permitted within the caps in §8. This is a bounded exception to the e3d-pilot RED classification of money movement. Any change to those caps still requires human approval. The text must be copied into the e3d-pilot autonomy policy when it exists.

**Open**
- **Phase 6 block.** `scripts/custodyControls.js` blocks live trading by policy ("cannot be enabled in Phase 6"). Lifting it is the go-live change in §9, to be reviewed separately.
- **Infura rate limits.** The free tier returned HTTP 429 during repeated fork runs. Every live trade makes several reads, so the production plan needs either a higher Infura tier or a read budget.
- **Flashbots behavior with real transactions.** Confirm inclusion timing and the 25-block window on a small live trade before raising caps.
- **The Infura key appears in process arguments** when anvil is launched with `--fork-url`. Acceptable on a single-user Mac, but worth knowing.
- **Mapping into the ledger.** The live fill's fields need to be written into `portfolio.live.json` in the same shape as paper fills, including the paper-only fields the live path doesn't produce.
