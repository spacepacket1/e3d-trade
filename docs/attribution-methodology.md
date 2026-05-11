# Attribution Methodology

`/attribution` is a directional view, not a causal proof. For each `risk_rejected` and `harvest_rejected` rule code, the endpoint builds a coarse bucket from `category`, `liquidity_band` (`floor(log10(liquidity_usd))`), `mcap_band` (`floor(log10(market_cap_usd))`), and `flow_signal`. It then looks at completed trades in the same time window whose open/close records land in that same bucket and averages their realized P&L percent.

The `by_rule` table answers: “when this rule blocked something that looked roughly like bucket X, how did the trades we actually took in bucket X perform?” A negative analogue average suggests the rule may be saving us from bad trades; a positive analogue average suggests the rule may be filtering out edge.

`verdict` is intentionally conservative:

- `rule_helps`: matched analogue average is more than 1 percentage point below the overall completed-trade average for the window.
- `rule_might_hurt`: matched analogue average is positive and more than 1 percentage point above the overall completed-trade average for the window.
- `inconclusive`: too few matched trades, no analogues, or the edge difference is too small/noisy.

Limits:

- The match is coarse. Different tokens can share a bucket while having very different fundamentals.
- Rejections are compared to trades we did take, not to a true counterfactual replay.
- Sparse data matters. Small samples can flip verdicts quickly.
- Historical logs may be missing newer metadata fields, which pushes some rows into `unknown` buckets.

Use this endpoint to rank where to investigate next, not to auto-disable rules.
