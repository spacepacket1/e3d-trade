---
head_sha: 8989fa53e200b606d6409914a7dd0653f196fc10
focus: default
implementation_run_id: impl-d815e4337624-repo-20261012003556
---

# Findings

## Local State

Approved idea `idea-d815e4337624` is being implemented for `/Users/mini/e3d-trade`.

## External Context

evaluateRotationActions (pipeline.js ~8800) sells the weakest held position whenever a candidate's score is >= rotation_threshold(10) higher, with no minimum hold and no cost term. Since 2026-09-01: 13 rotation_out exits netted -$1,753; holds <7d (17 trades) lost ~$2.7k while holds >=7d excluding QNT were fine. Last 7d: WALLET -$1,031 and NEURAL -$920 (held 4.3h) exceed the whole -$1.5k week. Friction is ~1.25% round trip on $9-14k positions. PROPOSAL: (a) rotation only if score_delta*k >= round-trip friction% + margin; (b) min hold (start 24-72h) overridable only by hard stop; (c) time-decayed hysteresis so older positions are harder to displace; (d) skip rotation when the buy leg would be blocked (category cap) so we never sell without buying. Ship behind a setting with shadow logging of would-have-blocked rotations first.
