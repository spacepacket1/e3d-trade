---
head_sha: 1de4a29cbd7afc60cfbea0d22195f4a634c8dccb
focus: default
implementation_run_id: impl-72aef771bbed-repo-20261001161528
---

# Findings

## Local State

Approved idea `idea-72aef771bbed` is being implemented for `/Users/mini/e3d-trade`.

## External Context

e3d-trade's trading cycle (Scout candidate discovery + Harvest position review) runs on a fixed 4x/day schedule (hours 0/6/12/18, see /Users/mini/e3d-maps/deploy/qwen_adapter_window_runner.sh) specifically because both agents share one local Qwen LLM worker with maps/story generation -- a full cycle costs real, scarce LLM time, so the schedule is deliberately conservative rather than running whenever something might be worth checking.

This candidate adds a cheap, cheap-to-run Jev (TypeSafe System One) check that runs independently of that schedule, on a tight cadence (every 15 minutes), to build a calibration record of whether Jev's judgment on 'has enough changed to warrant a full cycle right now' would have agreed with what the real, scheduled cycle actually found when it eventually ran. This is pure shadow mode: the check NEVER triggers, skips, or in any way alters when the real Scout/Harvest cycle executes. It only logs its own verdict and, after each real scheduled cycle completes, logs what that cycle actually found (new qualified candidates, held-position price moves large enough to matter), so the two can be compared later.

This is explicitly Phase 1 of a larger idea (see non-goals) -- it establishes whether Jev is trustworthy enough to later inform real cycle cadence, Scout candidate triage, or Harvest position-skip decisions, none of which are in scope here. Follow directly the existing, verified-correct Jev wire format and shadow-mode pattern already used in scripts/jevRecurringGate.js (merged Sep 2026, api.typesafe.ai/v1/systemone, Noul/Score/Choice with nested criteria -- do not re-derive this from general knowledge, model this new gate's request/response handling directly on that file's buildJevRequestBody/normalizeJevResponse, since this exact API has repeatedly been hallucinated by draft LLMs with a different, incorrect schema in earlier work on this codebase).

SCOPE:
1. A new script (e.g. scripts/jevCycleCadenceGate.js) that: builds a cheap snapshot of 'what's changed since the last real cycle' -- count and top composite_score of cognitive_state candidates (reuse buildCognitiveState's output, do not re-fetch e3d API data independently), and for held positions, current_price vs the price at last cycle's snapshot time (from portfolio.json, already-loaded, no new fetches). Sends this to Jev as a Noul question ('does this change warrant running a full Scout/Harvest cycle now, ahead of the next scheduled window?'). Logs the verdict. Never calls pipeline.js, never mutates portfolio.json, never skips or triggers anything.
2. A lightweight wrapper/cron entry that runs this check every 15 minutes, completely independent of and without modifying qwen_adapter_window_runner.sh's own schedule or trading-window logic.
3. After each real scheduled cycle (detectable via logs/pipeline.jsonl's cycle_end events or portfolio.json's stats timestamps), log what that cycle actually found -- new approved candidates, positions whose price moved meaningfully since the prior cycle -- associated with whichever shadow-mode Jev verdicts fell in the window since the previous real cycle, so a human can later assess whether Jev's 'worth checking now' calls would have been right.
4. A verify script covering the Noul request/response shape, the snapshot-building logic, and that no code path in this change can trigger, skip, or alter a real trading cycle.

NON-GOALS (explicitly out of scope for this idea -- do not implement):
- Changing when Scout/Harvest cycles actually run, now or ever, as part of this candidate. This is pure logging/calibration.
- Scout candidate triage via Jev (letting Jev pre-rank which candidates Qwen reasons about) -- a separate, later idea once this calibration data exists.
- Harvest position-skip via Jev (letting Jev decide which held positions get full LLM re-review each cycle) -- a separate, later idea.
- Any change to qwen_adapter_window_runner.sh's scheduling, window logic, or shared-LLM-worker coordination.
- Any change to Scout's or Harvest's actual candidate-scoring, exit-decision, or risk logic.
