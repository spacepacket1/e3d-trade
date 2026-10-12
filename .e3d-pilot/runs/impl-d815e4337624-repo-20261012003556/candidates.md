---
selected: rotation-friction-hurdle-min-hold
reason: approved idea implementation
focus: default
---

# Candidates

## Proposed Candidates

### Candidate rotation-friction-hurdle-min-hold: Make rotation_out friction-aware: require score delta to clear round-trip cost plus margin, enforce a minimum hold, and add re-entry hysteresis
Duplicate: no
Dedup rationale: From 2026-10-11 research pass (GitHub repos + papers/blogs; no X posts were retrievable) after diagnosing the 7d loss as rotation churn. Not a duplicate of merged ideas 02c2732 (profit-take calibration), f07eca2 (flow-only), fc54d00, 72aef77.
Category: risk/strategy
Analogy: freqtrade CooldownPeriod/protections and Hummingbot time_limit barrier; hysteresis bands in portfolio turnover control
Attraction (1-5): 3
Retention (1-5): 4
Effort: 2
Revenue (1-5|n/a): 4
Description: evaluateRotationActions (pipeline.js ~8800) sells the weakest held position whenever a candidate's score is >= rotation_threshold(10) higher, with no minimum hold and no cost term. Since 2026-09-01: 13 rotation_out exits netted -$1,753; holds <7d (17 trades) lost ~$2.7k while holds >=7d excluding QNT were fine. Last 7d: WALLET -$1,031 and NEURAL -$920 (held 4.3h) exceed the whole -$1.5k week. Friction is ~1.25% round trip on $9-14k positions. PROPOSAL: (a) rotation only if score_delta*k >= round-trip friction% + margin; (b) min hold (start 24-72h) overridable only by hard stop; (c) time-decayed hysteresis so older positions are harder to displace; (d) skip rotation when the buy leg would be blocked (category cap) so we never sell without buying. Ship behind a setting with shadow logging of would-have-blocked rotations first.
