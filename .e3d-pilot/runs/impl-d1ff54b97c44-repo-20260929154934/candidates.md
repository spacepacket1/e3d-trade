---
selected: jev-recurring-gate-v2
reason: approved idea implementation
focus: default
---

# Candidates

## Proposed Candidates

### Candidate jev-recurring-gate-v2: Jev shadow-mode pre-screen gate for recurring e3d-pilot discover/ideate runs
Duplicate: no
Dedup rationale: Independently proposed by all four discover/ideate providers (devin, codex, claude) in run run-20260929061413-jev-continuous as near-identical candidates (candidate 15/10/5), converging on the same design -- this promotes the most complete of the three (devin's, which adds the composite fingerprint and hard-max-interval safety valve) rather than letting the deterministic scoring step's low ensemble score (18-27, versus 91 for a generic dashboard candidate) silently drop it. The scoring rubric under-weights internal cost-savings tooling relative to user-facing features -- claude's own candidate explicitly self-flagged this: 'honestly scored low on user attraction/retention despite being the session's explicit research focus.' The existing draft PR (e3d-pilot/2026-07-29-e3d-trade) is an unrelated dashboard/evidence-UI idea, not a duplicate. Not from an automated discover/ideate selection -- manually promoted from the full candidate pool per direct repo-owner request in conversation on 2026-09-29. Supersedes idea-ad28b0015d2c, whose implementation approval went permanently stale (e3d-pilot resolves approved_base from source_run_id findings.md forever once one exists, with no refresh path) after an unrelated capital-mandate-expiry fix (c0c0148) was committed directly to the repo mid-session. Same content, already validated through negotiate (grok-build correctly caught missing Jev criteria and stdout-isolation gaps in the original codex draft; the negotiate-converged spec is preserved in idea-ad28b0015d2c run impl-ad28b0015d2c-repo-20260929134857).
Category: workflow
Analogy: developer-tool CLI ergonomics / incremental dirty-checking -- content-addressable build-cache skipping (e.g. Turborepo) applied to whether a full multi-provider discover/ideate pass is worth its cost this cycle.
Attraction (1-5): 2
Retention (1-5): 4
Effort: low
Revenue (1-5|n/a): 1
Description: Implement a shadow-mode Jev gate (opt-in on TYPESAFE_API_KEY) that runs one Jev call before each scheduled discover/ideate pass against e3d-trade: a composite fingerprint hash of (head_sha + performance_daily_row_count + signal_attribution_checksum + last_ideate_digest_sha) is diffed cycle over cycle, and Jev is asked three typed questions over that delta -- Noul ("is there enough change to justify a full multi-provider discover/ideate pass?"), Score ("how much of this delta is P&L-relevant -- touches entry/exit/sizing/execution cost?"), and Choice ("which profit loop moved: entry, harvest/exit, sizing, or execution cost?"). A missing key or a failed Jev call always means no signal -> the full pass runs, same opt-in-by-credential-presence convention as e3d-pilot's own lib/providers/jev.sh. This never skips a scheduled pass outright yet: log Jev's verdict alongside whether that cycle's full discover/ideate pass actually produced a shippable idea, purely for calibration, exactly mirroring the shadow-mode-first pattern already validated in e3d-pilot itself (lib/providers/jev.sh, lib/ideas/jev_dedup.sh, and the e3d-debate obviousness pre-screen). Enforce a hard maximum interval (e.g. 14 days) between full passes regardless of what the gate says, so a miscalibrated or stuck gate can never silently stop the improvement loop entirely. Promotion from shadow-mode logging to an actual skip decision happens only after a real sample shows a near-zero false-skip rate on cycles that would have found something -- not as part of this build.
