#!/usr/bin/env python3
"""
generate_synthetic_training_data.py

Generates synthetic OpenAI chat JSONL training examples for Scout and Harvest agents.

Usage:
    python3 generate_synthetic_training_data.py --agent scout|harvest|all --count 300 --output data/
"""

import argparse
import json
import os
import random
import math
from datetime import datetime, timedelta

# ---------------------------------------------------------------------------
# Constants & helpers
# ---------------------------------------------------------------------------

SCOUT_SYSTEM = (
    "You are Scout, an elite crypto trading research agent. "
    "Identify high-quality pre-pump entry candidates from on-chain signals. "
    "Return STRICT JSON only."
)

HARVEST_SYSTEM = (
    "You are Harvest, an elite crypto portfolio manager. "
    "Review held positions and decide to hold, monitor, trim, or exit based on "
    "signal state and P&L. Return STRICT JSON only."
)

SYMBOLS = [
    "REQ", "ENA", "XYZ", "NEAR", "SHFL", "GNO", "ENJ", "FET", "RNDR", "LPT",
    "API3", "OCEAN", "NMR", "RLC", "LINK", "BAND", "DIA", "TRB", "UMA", "INJ",
    "DYDX", "PERP", "SNX", "KWENTA", "GMX", "GNS", "MYRIA", "IMX", "GODS",
    "PRIME", "MAGIC", "RARE", "RARI", "DEGEN", "MEME", "PEPE", "TURBO", "LADYS",
    "WLD", "ID", "ARB", "OP", "METIS", "BOBA", "CELR", "KLAY", "SKALE",
]

CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon"]

REGIMES = ["bull", "bear", "crab", "recovery", "euphoria"]

PRE_PUMP_SIGNALS = ["STAGING", "CLUSTER", "FUNNEL", "NEW_WALLETS", "ACCUMULATION", "SMART_MONEY"]
POST_PUMP_SIGNALS = ["MOVER", "SURGE"]
ALL_SIGNALS = PRE_PUMP_SIGNALS + POST_PUMP_SIGNALS

THESIS_TEMPLATES = [
    "{sym} accumulation pattern — smart wallets stacking quietly",
    "{sym} showing cluster formation around key support",
    "{sym} funnel pattern: wallet cohort rotating in",
    "{sym} new wallet cohort entering at current price",
    "{sym} staging area — compressed price action before breakout",
    "{sym} smart money positioning for catalyst",
]


def fake_address():
    return "0x" + "".join(random.choices("0123456789abcdef", k=40))


def fake_ts(days_back_range=(0, 30)):
    base = datetime(2026, 4, 19, 12, 0, 0)
    delta = timedelta(days=random.randint(*days_back_range), hours=random.randint(0, 23))
    return (base - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def rand_pct(low, high):
    return round(random.uniform(low, high), 2)


def rand_k(low, high):
    """Return a value in raw units where low/high are in thousands."""
    return round(random.uniform(low * 1000, high * 1000), 0)


def rand_m(low, high):
    """Return a value in raw units where low/high are in millions."""
    return round(random.uniform(low * 1_000_000, high * 1_000_000), 0)


def fmt_k(val):
    return f"{val/1000:.0f}k"


def fmt_m(val):
    return f"{val/1_000_000:.1f}M"


def entry_zone(price):
    low = round(price * 0.96, 6)
    high = round(price * 1.04, 6)
    return {"low": low, "high": high}


def pick_sym(exclude=None):
    pool = [s for s in SYMBOLS if s != exclude]
    return random.choice(pool)


def signal_age_h():
    return random.randint(1, 72)


# ---------------------------------------------------------------------------
# Scout example builders
# ---------------------------------------------------------------------------

def scout_no_candidates(stories_checked, reason_comment=""):
    return {
        "scan_timestamp": fake_ts(),
        "candidates": [],
        "stories_checked": stories_checked,
        "debug": reason_comment,
    }


def scout_candidate(sym, tier, confidence, why_now, evidence, price=None):
    if price is None:
        price = round(random.uniform(0.01, 50.0), 6)
    return {
        "token": {
            "symbol": sym,
            "contract_address": fake_address(),
            "chain": random.choice(CHAINS),
        },
        "tier": tier,
        "action": "buy",
        "confidence": confidence,
        "why_now": why_now,
        "evidence": evidence,
        "entry_zone": entry_zone(price),
    }


def build_scout_user(
    sym,
    story_signals,        # list of (signal_type, in_universe, change_24h)
    flow_tokens,          # list of (sym, ratio, liq_usd, vol_usd, mcap_usd)
    theses,               # list of (sym, conviction, direction, brief)
    e3d_candidates_count,
    btc_change=None,
    fg_score=None,
    regime=None,
    cg_data=None,         # list of (sym, change_7d, ath_pct, rank)
):
    ts = fake_ts()
    regime = regime or random.choice(REGIMES)
    btc_change = btc_change if btc_change is not None else rand_pct(-5, 8)
    fg_score = fg_score if fg_score is not None else random.randint(20, 85)

    lines = [
        f"SCAN: {ts}",
        f"MACRO: {regime} | BTC 24h: {btc_change}% | Fear/Greed: {fg_score}/100",
        "",
        f"STORY SIGNALS ({len(story_signals)} found):",
    ]
    for (stype, in_univ, ch24) in story_signals:
        lines.append(f"- {stype} on {sym} | in_universe: {str(in_univ).lower()} | change_24h: {ch24}%")

    lines.append("")
    lines.append("FLOW ACCUMULATION (top 3):")
    for (fsym, ratio, liq, vol, mcap) in flow_tokens[:3]:
        lines.append(
            f"- {fsym}: ratio {ratio}x | liq ${fmt_k(liq)} | vol24h ${fmt_k(vol)} | mcap ${fmt_m(mcap)}"
        )

    if theses:
        lines.append("")
        lines.append("ACTIVE THESES (LONG):")
        for (tsym, conv, direction, brief) in theses:
            lines.append(f"- {tsym} conviction {conv}: {brief}")

    lines.append("")
    lines.append(f"E3D CANDIDATES IN UNIVERSE: {e3d_candidates_count}")

    if cg_data:
        lines.append("")
        lines.append("COINGECKO RESEARCH:")
        for (csym, ch7, ath_pct, rank) in cg_data:
            lines.append(f"- {csym}: 7d {ch7}% | ATH -{ath_pct}% | rank #{rank}")

    return "\n".join(lines)


# --- Scout scenario generators ---

def gen_scout_mover_skip(sym=None):
    """POST-PUMP signal — should produce no candidates."""
    sym = sym or pick_sym()
    signal = random.choice(POST_PUMP_SIGNALS)
    liq = rand_k(200, 2000)
    vol = rand_k(80, 500)
    mcap = rand_m(5, 100)
    change_24h = rand_pct(15, 80)

    story = [(signal, True, change_24h)]
    flow = [(sym, round(random.uniform(2.0, 5.0), 1), liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=[(sym, rand_pct(20, 120), rand_pct(10, 60), random.randint(50, 500))])
    assistant = json.dumps(scout_no_candidates([f"{signal}:{sym}"], "post-pump signal — skip"))
    return user, assistant


def gen_scout_surge_skip(sym=None):
    """SURGE signal — should produce no candidates."""
    sym = sym or pick_sym()
    liq = rand_k(300, 3000)
    vol = rand_k(100, 1000)
    mcap = rand_m(10, 200)
    change_24h = rand_pct(25, 120)

    story = [("SURGE", True, change_24h)]
    flow = [(sym, round(random.uniform(3.0, 8.0), 1), liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 1)
    assistant = json.dumps(scout_no_candidates(["SURGE:" + sym], "surge = post-pump, no entry"))
    return user, assistant


def gen_scout_tier1_multi_signal(sym=None):
    """2+ pre-pump signals on same token — TIER_1."""
    sym = sym or pick_sym()
    sigs = random.sample(PRE_PUMP_SIGNALS, k=random.randint(2, 3))
    liq = rand_k(200, 5000)
    vol = rand_k(50, 500)
    mcap = rand_m(5, 500)
    change_24h = rand_pct(-5, 15)
    change_7d = rand_pct(-20, 100)

    story = [(s, True, change_24h) for s in sigs]
    flow = [(sym, round(random.uniform(2.0, 6.0), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(20, 80), random.randint(30, 400))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)

    confidence = random.randint(70, 90)
    why = f"{len(sigs)} pre-pump signals active ({', '.join(sigs)}). Strong accumulation before breakout."
    evidence = [f"{s} detected on {sym}" for s in sigs]
    price = round(random.uniform(0.02, 20.0), 6)
    candidate = scout_candidate(sym, "TIER_1", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"{s}:{sym}" for s in sigs],
    }
    return user, json.dumps(result)


def gen_scout_flow_only_above_threshold(sym=None):
    """Flow ratio >= 3.5, all thresholds met — should produce TIER_2 candidate."""
    sym = sym or pick_sym()
    ratio = round(random.uniform(3.5, 8.0), 1)
    liq = rand_k(150, 2000)   # > 150k
    vol = rand_k(75, 500)     # > 75k
    mcap = rand_m(5, 200)     # > 5M
    change_7d = rand_pct(-30, 150)

    flow = [(sym, ratio, liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(30, 85), random.randint(50, 600))]
    # No story signals
    user = build_scout_user(sym, [], flow, [], 0, cg_data=cg)

    confidence = random.randint(60, 75)
    why = f"Flow-only: {ratio}x accumulation ratio exceeds threshold. Liq ${fmt_k(liq)}, vol ${fmt_k(vol)}, mcap ${fmt_m(mcap)}."
    evidence = [f"Flow ratio {ratio}x (threshold 3.5x)", f"Liq ${fmt_k(liq)} > $150k", f"Vol ${fmt_k(vol)} > $75k"]
    price = round(random.uniform(0.01, 10.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [],
    }
    return user, json.dumps(result)


def gen_scout_flow_only_below_threshold_ratio(sym=None):
    """Flow ratio exactly below 3.5 — no candidate."""
    sym = sym or pick_sym()
    ratio = round(random.uniform(2.0, 3.49), 2)
    liq = rand_k(200, 1000)
    vol = rand_k(80, 300)
    mcap = rand_m(6, 100)

    flow = [(sym, ratio, liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, [], 0)
    assistant = json.dumps(scout_no_candidates([], f"flow ratio {ratio}x below 3.5 threshold"))
    return user, assistant


def gen_scout_flow_only_boundary_ratio_34(sym=None):
    """Flow ratio exactly 3.4 — below threshold, no candidate."""
    sym = sym or pick_sym()
    ratio = 3.4
    liq = rand_k(200, 500)
    vol = rand_k(100, 200)
    mcap = rand_m(8, 50)

    flow = [(sym, ratio, liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, [], 0)
    assistant = json.dumps(scout_no_candidates([], "ratio 3.4 — below 3.5 FLOW-ONLY threshold, skip"))
    return user, assistant


def gen_scout_flow_only_boundary_ratio_35(sym=None):
    """Flow ratio exactly 3.5 — at threshold, should fire."""
    sym = sym or pick_sym()
    ratio = 3.5
    liq = rand_k(160, 400)
    vol = rand_k(80, 200)
    mcap = rand_m(6, 50)
    change_7d = rand_pct(-20, 80)

    flow = [(sym, ratio, liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(25, 70), random.randint(80, 500))]
    user = build_scout_user(sym, [], flow, [], 0, cg_data=cg)

    confidence = 61
    why = f"Flow ratio exactly 3.5x meets FLOW-ONLY threshold. Minimal but qualifying setup."
    evidence = ["Flow ratio 3.5x (meets 3.5 threshold)", f"Liq ${fmt_k(liq)} > $150k"]
    price = round(random.uniform(0.05, 5.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [],
    }
    return user, json.dumps(result)


def gen_scout_flow_only_liq_below(sym=None):
    """Flow ratio >= 3.5 but liq < 150k — no candidate."""
    sym = sym or pick_sym()
    ratio = round(random.uniform(3.5, 6.0), 1)
    liq = rand_k(50, 149)    # below 150k
    vol = rand_k(80, 200)
    mcap = rand_m(6, 50)

    flow = [(sym, ratio, liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, [], 0)
    assistant = json.dumps(scout_no_candidates([], f"flow ratio {ratio}x but liq ${fmt_k(liq)} < $150k — fail"))
    return user, assistant


def gen_scout_quality_gate_liq_fail(sym=None):
    """Story signal present but liq < 100k — quality gate fail."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(10, 99)    # < 100k
    vol = rand_k(20, 80)
    mcap = rand_m(2, 20)
    change_24h = rand_pct(-3, 10)

    story = [(sig, True, change_24h)]
    flow = [(sym, round(random.uniform(1.5, 3.0), 1), liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 1)
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], f"quality gate fail: liq ${fmt_k(liq)} < $100k"))
    return user, assistant


def gen_scout_quality_gate_liq_boundary_99k(sym=None):
    """Liq exactly $99k — quality gate fail."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = 99000
    vol = rand_k(15, 50)
    mcap = rand_m(2, 10)

    story = [(sig, True, rand_pct(-2, 8))]
    flow = [(sym, 2.0, liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 1)
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], "quality gate fail: liq $99k < $100k minimum"))
    return user, assistant


def gen_scout_quality_gate_liq_boundary_101k(sym=None):
    """Liq exactly $101k — quality gate pass (if other gates pass)."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = 101000
    vol = rand_k(15, 60)
    mcap = rand_m(3, 20)
    change_24h = rand_pct(-3, 8)

    story = [(sig, True, change_24h)]
    flow = [(sym, 2.5, liq, vol, mcap)]
    cg = [(sym, rand_pct(-10, 50), rand_pct(30, 80), random.randint(100, 600))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)

    confidence = random.randint(58, 70)
    why = f"{sig} signal with liq $101k passing quality gate. Single pre-pump signal."
    evidence = [f"{sig} active on {sym}", "Liq $101k passes $100k quality gate"]
    price = round(random.uniform(0.01, 5.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"{sig}:{sym}"],
    }
    return user, json.dumps(result)


def gen_scout_quality_gate_mcap_fail(sym=None):
    """Market cap < 2M — quality gate fail."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(120, 500)
    vol = rand_k(15, 80)
    mcap = rand_m(0.1, 1.9)   # < 2M

    story = [(sig, True, rand_pct(-3, 12))]
    flow = [(sym, 2.5, liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 1)
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], f"quality gate fail: mcap ${fmt_m(mcap)} < $2M"))
    return user, assistant


def gen_scout_quality_gate_vol_fail(sym=None):
    """Volume 24h < 10k — quality gate fail."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(120, 500)
    vol = rand_k(0.5, 9.9)   # < 10k
    mcap = rand_m(3, 30)

    story = [(sig, True, rand_pct(-3, 10))]
    flow = [(sym, 2.5, liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 1)
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], f"quality gate fail: vol ${fmt_k(vol)} < $10k"))
    return user, assistant


def gen_scout_pump_filter_above_300(sym=None):
    """change_7d > 300% — pump filter, skip."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(200, 1000)
    vol = rand_k(50, 300)
    mcap = rand_m(5, 100)
    change_7d = rand_pct(301, 600)

    story = [(sig, True, rand_pct(5, 30))]
    flow = [(sym, round(random.uniform(2.0, 5.0), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(5, 30), random.randint(100, 500))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], f"pump filter: change_7d {change_7d}% > 300% — skip"))
    return user, assistant


def gen_scout_pump_filter_boundary_299(sym=None):
    """change_7d exactly 299% — below pump filter, proceed."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(200, 800)
    vol = rand_k(50, 200)
    mcap = rand_m(5, 80)
    change_7d = 299.0

    story = [(sig, True, rand_pct(2, 20))]
    flow = [(sym, round(random.uniform(2.0, 4.0), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(20, 60), random.randint(80, 400))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)

    confidence = random.randint(58, 70)
    why = f"{sig} signal. 7d change 299% — just below pump filter threshold."
    evidence = [f"{sig} active", f"7d change 299% (below 300% pump filter)", f"Liq ${fmt_k(liq)} passes quality gate"]
    price = round(random.uniform(0.05, 15.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"{sig}:{sym}"],
    }
    return user, json.dumps(result)


def gen_scout_pump_filter_boundary_301(sym=None):
    """change_7d exactly 301% — pump filter fires, skip."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(200, 800)
    vol = rand_k(50, 200)
    mcap = rand_m(5, 80)
    change_7d = 301.0

    story = [(sig, True, rand_pct(5, 25))]
    flow = [(sym, 3.0, liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(5, 25), random.randint(80, 400))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], "pump filter: change_7d 301% > 300% — skip regardless"))
    return user, assistant


def gen_scout_thesis_exception_conviction_66(sym=None):
    """Conviction >= 65 and LONG direction, no universe match — thesis exception fires."""
    sym = sym or pick_sym()
    conviction = random.randint(65, 90)
    brief = random.choice(THESIS_TEMPLATES).format(sym=sym)
    liq = rand_k(150, 1000)
    vol = rand_k(30, 200)
    mcap = rand_m(3, 50)

    theses = [(sym, conviction, "LONG", brief)]
    # Token NOT in universe
    flow = [(sym, round(random.uniform(1.5, 3.4), 1), liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, theses, 0)  # 0 e3d candidates, not in universe

    confidence = min(conviction + 5, 95)
    why = f"Thesis exception: conviction {conviction} LONG thesis triggers entry despite no universe match."
    evidence = [f"Active LONG thesis conviction {conviction}", brief]
    price = round(random.uniform(0.05, 20.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [],
    }
    return user, json.dumps(result)


def gen_scout_thesis_exception_conviction_64(sym=None):
    """Conviction exactly 64 — below threshold, no thesis exception."""
    sym = sym or pick_sym()
    conviction = 64
    brief = random.choice(THESIS_TEMPLATES).format(sym=sym)
    liq = rand_k(150, 500)
    vol = rand_k(30, 150)
    mcap = rand_m(3, 30)

    theses = [(sym, conviction, "LONG", brief)]
    flow = [(sym, 2.5, liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, theses, 0)
    assistant = json.dumps(scout_no_candidates([], f"thesis conviction {conviction} < 65 — exception does not fire"))
    return user, assistant


def gen_scout_thesis_exception_conviction_65(sym=None):
    """Conviction exactly 65 — at threshold, exception fires."""
    sym = sym or pick_sym()
    conviction = 65
    brief = random.choice(THESIS_TEMPLATES).format(sym=sym)
    liq = rand_k(150, 500)
    vol = rand_k(30, 150)
    mcap = rand_m(3, 30)

    theses = [(sym, conviction, "LONG", brief)]
    flow = [(sym, 2.5, liq, vol, mcap)]
    cg = [(sym, rand_pct(-20, 80), rand_pct(30, 70), random.randint(100, 500))]
    user = build_scout_user(sym, [], flow, theses, 0, cg_data=cg)

    confidence = 70
    why = f"Thesis exception: conviction exactly 65 — threshold met. LONG thesis triggers entry."
    evidence = [f"LONG thesis conviction 65 (threshold)", brief]
    price = round(random.uniform(0.05, 10.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [],
    }
    return user, json.dumps(result)


def gen_scout_tier2_single_signal(sym=None):
    """Single pre-pump signal, quality gates pass — TIER_2."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(120, 3000)
    vol = rand_k(15, 400)
    mcap = rand_m(3, 200)
    change_24h = rand_pct(-5, 15)
    change_7d = rand_pct(-30, 200)

    story = [(sig, True, change_24h)]
    flow = [(sym, round(random.uniform(1.5, 3.4), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(20, 80), random.randint(50, 600))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)

    confidence = random.randint(58, 72)
    why = f"Single {sig} signal. Meets quality gates. TIER_2 entry."
    evidence = [f"{sig} detected", f"Liq ${fmt_k(liq)}", f"7d: {change_7d}%"]
    price = round(random.uniform(0.01, 30.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"{sig}:{sym}"],
    }
    return user, json.dumps(result)


def gen_scout_not_in_universe_no_thesis(sym=None):
    """Story signal but token not in universe and no thesis — no candidate."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(150, 1000)
    vol = rand_k(20, 200)
    mcap = rand_m(3, 50)

    story = [(sig, False, rand_pct(-5, 15))]  # in_universe: false
    flow = [(sym, 2.0, liq, vol, mcap)]
    user = build_scout_user(sym, story, flow, [], 0)  # 0 e3d candidates
    assistant = json.dumps(scout_no_candidates([f"{sig}:{sym}"], "not in universe and no qualifying thesis — skip"))
    return user, assistant


def gen_scout_mover_with_pre_pump_elsewhere(sym_mover=None, sym_pre=None):
    """MOVER on one token, STAGING on another — skip mover, buy the pre-pump."""
    sym_mover = sym_mover or pick_sym()
    sym_pre = sym_pre or pick_sym(exclude=sym_mover)
    sig_pre = random.choice(PRE_PUMP_SIGNALS)

    liq_m = rand_k(300, 2000)
    vol_m = rand_k(100, 600)
    mcap_m = rand_m(10, 200)

    liq_p = rand_k(150, 1500)
    vol_p = rand_k(20, 300)
    mcap_p = rand_m(3, 100)
    change_24h_p = rand_pct(-3, 12)
    change_7d_p = rand_pct(-20, 150)

    # Two story signals, different tokens
    lines = [
        f"SCAN: {fake_ts()}",
        f"MACRO: {random.choice(REGIMES)} | BTC 24h: {rand_pct(-3, 5)}% | Fear/Greed: {random.randint(30, 75)}/100",
        "",
        "STORY SIGNALS (2 found):",
        f"- MOVER on {sym_mover} | in_universe: true | change_24h: {rand_pct(20, 60)}%",
        f"- {sig_pre} on {sym_pre} | in_universe: true | change_24h: {change_24h_p}%",
        "",
        "FLOW ACCUMULATION (top 3):",
        f"- {sym_mover}: ratio {round(random.uniform(3,6),1)}x | liq ${fmt_k(liq_m)} | vol24h ${fmt_k(vol_m)} | mcap ${fmt_m(mcap_m)}",
        f"- {sym_pre}: ratio {round(random.uniform(1.5,3.4),1)}x | liq ${fmt_k(liq_p)} | vol24h ${fmt_k(vol_p)} | mcap ${fmt_m(mcap_p)}",
        "",
        f"E3D CANDIDATES IN UNIVERSE: 2",
        "",
        "COINGECKO RESEARCH:",
        f"- {sym_mover}: 7d {rand_pct(30, 150)}% | ATH -{rand_pct(10, 40)}% | rank #{random.randint(50, 300)}",
        f"- {sym_pre}: 7d {change_7d_p}% | ATH -{rand_pct(25, 75)}% | rank #{random.randint(100, 600)}",
    ]
    user = "\n".join(lines)

    confidence = random.randint(60, 72)
    why = f"MOVER on {sym_mover} skipped (post-pump). {sig_pre} on {sym_pre} is pre-pump signal."
    evidence = [f"{sig_pre} active on {sym_pre}", f"MOVER on {sym_mover} excluded (post-pump)"]
    price = round(random.uniform(0.05, 20.0), 6)
    candidate = scout_candidate(sym_pre, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"MOVER:{sym_mover}", f"{sig_pre}:{sym_pre}"],
    }
    return user, json.dumps(result)


def gen_scout_flow_only_max_one_candidate(sym=None):
    """Multiple flow tokens above threshold — return only 1 candidate."""
    sym1 = pick_sym()
    sym2 = pick_sym(exclude=sym1)
    ratio1 = round(random.uniform(4.0, 7.0), 1)
    ratio2 = round(random.uniform(3.5, 5.0), 1)
    liq1 = rand_k(200, 1000)
    vol1 = rand_k(100, 400)
    mcap1 = rand_m(6, 100)
    liq2 = rand_k(180, 800)
    vol2 = rand_k(80, 300)
    mcap2 = rand_m(5, 80)

    lines = [
        f"SCAN: {fake_ts()}",
        f"MACRO: {random.choice(REGIMES)} | BTC 24h: {rand_pct(-2, 6)}% | Fear/Greed: {random.randint(35, 80)}/100",
        "",
        "STORY SIGNALS (0 found):",
        "",
        "FLOW ACCUMULATION (top 3):",
        f"- {sym1}: ratio {ratio1}x | liq ${fmt_k(liq1)} | vol24h ${fmt_k(vol1)} | mcap ${fmt_m(mcap1)}",
        f"- {sym2}: ratio {ratio2}x | liq ${fmt_k(liq2)} | vol24h ${fmt_k(vol2)} | mcap ${fmt_m(mcap2)}",
        "",
        f"E3D CANDIDATES IN UNIVERSE: 0",
    ]
    user = "\n".join(lines)

    confidence = random.randint(60, 72)
    why = f"Flow-only: {ratio1}x ratio — strongest qualifying token. FLOW-ONLY rule: max 1 candidate."
    evidence = [f"Flow ratio {ratio1}x > 3.5 threshold", f"Liq ${fmt_k(liq1)} > $150k", "Max 1 flow-only candidate returned"]
    price = round(random.uniform(0.02, 10.0), 6)
    candidate = scout_candidate(sym1, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [],
    }
    return user, json.dumps(result)


def gen_scout_no_signals_no_candidates():
    """Empty scan — nothing fires."""
    sym = pick_sym()
    liq = rand_k(50, 200)
    vol = rand_k(5, 50)
    mcap = rand_m(1, 20)

    flow = [(sym, round(random.uniform(0.5, 2.0), 1), liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, [], 0)
    assistant = json.dumps(scout_no_candidates([], "no qualifying signals"))
    return user, assistant


def gen_scout_accumulation_smart_money_tier1(sym=None):
    """ACCUMULATION + SMART_MONEY on same token — classic TIER_1."""
    sym = sym or pick_sym()
    liq = rand_k(300, 5000)
    vol = rand_k(50, 500)
    mcap = rand_m(5, 300)
    change_24h = rand_pct(-3, 10)
    change_7d = rand_pct(-20, 120)

    story = [("ACCUMULATION", True, change_24h), ("SMART_MONEY", True, change_24h)]
    flow = [(sym, round(random.uniform(2.5, 5.0), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(20, 70), random.randint(40, 400))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)

    confidence = random.randint(75, 90)
    why = "ACCUMULATION + SMART_MONEY co-firing. Institutional accumulation detected."
    evidence = ["ACCUMULATION signal active", "SMART_MONEY signal active", "Two pre-pump signals = TIER_1"]
    price = round(random.uniform(0.05, 25.0), 6)
    candidate = scout_candidate(sym, "TIER_1", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"ACCUMULATION:{sym}", f"SMART_MONEY:{sym}"],
    }
    return user, json.dumps(result)


def gen_scout_staging_cluster_funnel_tier1(sym=None):
    """3-way STAGING + CLUSTER + FUNNEL — high confidence TIER_1."""
    sym = sym or pick_sym()
    liq = rand_k(400, 8000)
    vol = rand_k(80, 800)
    mcap = rand_m(10, 500)
    change_24h = rand_pct(-5, 8)
    change_7d = rand_pct(-30, 180)

    story = [
        ("STAGING", True, change_24h),
        ("CLUSTER", True, change_24h),
        ("FUNNEL", True, change_24h),
    ]
    flow = [(sym, round(random.uniform(3.0, 6.0), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(15, 65), random.randint(30, 300))]
    user = build_scout_user(sym, story, flow, [], 1, cg_data=cg)

    confidence = random.randint(82, 95)
    why = "Three pre-pump signals co-firing (STAGING+CLUSTER+FUNNEL). High-conviction setup."
    evidence = ["STAGING active", "CLUSTER active", "FUNNEL active", "3 pre-pump signals = TIER_1 high conviction"]
    price = round(random.uniform(0.05, 30.0), 6)
    candidate = scout_candidate(sym, "TIER_1", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"STAGING:{sym}", f"CLUSTER:{sym}", f"FUNNEL:{sym}"],
    }
    return user, json.dumps(result)


def gen_scout_thesis_long_with_universe_match(sym=None):
    """Thesis + universe match — compound signal, high confidence."""
    sym = sym or pick_sym()
    sig = random.choice(PRE_PUMP_SIGNALS)
    conviction = random.randint(65, 85)
    brief = random.choice(THESIS_TEMPLATES).format(sym=sym)
    liq = rand_k(200, 2000)
    vol = rand_k(30, 400)
    mcap = rand_m(4, 150)
    change_24h = rand_pct(-4, 12)
    change_7d = rand_pct(-25, 150)

    story = [(sig, True, change_24h)]
    flow = [(sym, round(random.uniform(2.0, 4.5), 1), liq, vol, mcap)]
    theses = [(sym, conviction, "LONG", brief)]
    cg = [(sym, change_7d, rand_pct(20, 70), random.randint(60, 500))]
    user = build_scout_user(sym, story, flow, theses, 1, cg_data=cg)

    confidence = min(conviction + 10, 95)
    why = f"{sig} signal + LONG thesis conviction {conviction}. Compound signal with universe match."
    evidence = [f"{sig} active", f"LONG thesis conviction {conviction}", brief, "In universe"]
    price = round(random.uniform(0.05, 20.0), 6)
    candidate = scout_candidate(sym, "TIER_2", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"{sig}:{sym}"],
    }
    return user, json.dumps(result)


def gen_scout_bear_regime_conservative(sym=None):
    """Bear regime — still buy on strong TIER_1 but note regime."""
    sym = sym or pick_sym()
    sigs = random.sample(PRE_PUMP_SIGNALS, 2)
    liq = rand_k(300, 3000)
    vol = rand_k(50, 400)
    mcap = rand_m(5, 200)
    change_24h = rand_pct(-8, 5)
    change_7d = rand_pct(-40, 20)

    story = [(s, True, change_24h) for s in sigs]
    flow = [(sym, round(random.uniform(2.5, 5.0), 1), liq, vol, mcap)]
    cg = [(sym, change_7d, rand_pct(30, 80), random.randint(60, 400))]
    user = build_scout_user(sym, story, flow, [], 1, regime="bear", cg_data=cg)

    confidence = random.randint(65, 80)
    why = f"TIER_1 setup in bear regime: {sigs[0]}+{sigs[1]} co-firing. Size conservatively."
    evidence = [f"{sigs[0]} active", f"{sigs[1]} active", "Bear regime — reduce size"]
    price = round(random.uniform(0.02, 20.0), 6)
    candidate = scout_candidate(sym, "TIER_1", confidence, why, evidence, price)
    result = {
        "scan_timestamp": fake_ts(),
        "candidates": [candidate],
        "stories_checked": [f"{s}:{sym}" for s in sigs],
    }
    return user, json.dumps(result)


def gen_scout_flow_only_vol_fail(sym=None):
    """Flow ratio >= 3.5 but vol < 75k — flow-only threshold fail."""
    sym = sym or pick_sym()
    ratio = round(random.uniform(3.5, 6.0), 1)
    liq = rand_k(200, 800)
    vol = rand_k(5, 74)    # < 75k
    mcap = rand_m(6, 80)

    flow = [(sym, ratio, liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, [], 0)
    assistant = json.dumps(scout_no_candidates([], f"flow ratio {ratio}x but vol ${fmt_k(vol)} < $75k — fail"))
    return user, assistant


def gen_scout_flow_only_mcap_fail(sym=None):
    """Flow ratio >= 3.5 but mcap < 5M — flow-only threshold fail."""
    sym = sym or pick_sym()
    ratio = round(random.uniform(3.5, 6.0), 1)
    liq = rand_k(200, 800)
    vol = rand_k(80, 300)
    mcap = rand_m(0.5, 4.9)   # < 5M

    flow = [(sym, ratio, liq, vol, mcap)]
    user = build_scout_user(sym, [], flow, [], 0)
    assistant = json.dumps(scout_no_candidates([], f"flow ratio {ratio}x but mcap ${fmt_m(mcap)} < $5M — fail"))
    return user, assistant


# Map scenario name -> generator function
SCOUT_SCENARIOS = {
    "mover_skip": gen_scout_mover_skip,
    "surge_skip": gen_scout_surge_skip,
    "tier1_multi_signal": gen_scout_tier1_multi_signal,
    "flow_only_above": gen_scout_flow_only_above_threshold,
    "flow_only_below_ratio": gen_scout_flow_only_below_threshold_ratio,
    "flow_only_boundary_34": gen_scout_flow_only_boundary_ratio_34,
    "flow_only_boundary_35": gen_scout_flow_only_boundary_ratio_35,
    "flow_only_liq_below": gen_scout_flow_only_liq_below,
    "quality_gate_liq_fail": gen_scout_quality_gate_liq_fail,
    "quality_gate_liq_99k": gen_scout_quality_gate_liq_boundary_99k,
    "quality_gate_liq_101k": gen_scout_quality_gate_liq_boundary_101k,
    "quality_gate_mcap_fail": gen_scout_quality_gate_mcap_fail,
    "quality_gate_vol_fail": gen_scout_quality_gate_vol_fail,
    "pump_filter_above_300": gen_scout_pump_filter_above_300,
    "pump_filter_boundary_299": gen_scout_pump_filter_boundary_299,
    "pump_filter_boundary_301": gen_scout_pump_filter_boundary_301,
    "thesis_exception_66": gen_scout_thesis_exception_conviction_66,
    "thesis_exception_64": gen_scout_thesis_exception_conviction_64,
    "thesis_exception_65": gen_scout_thesis_exception_conviction_65,
    "tier2_single_signal": gen_scout_tier2_single_signal,
    "not_in_universe_no_thesis": gen_scout_not_in_universe_no_thesis,
    "mover_with_pre_pump": gen_scout_mover_with_pre_pump_elsewhere,
    "flow_only_max_one": gen_scout_flow_only_max_one_candidate,
    "no_signals": gen_scout_no_signals_no_candidates,
    "accumulation_smart_money": gen_scout_accumulation_smart_money_tier1,
    "staging_cluster_funnel": gen_scout_staging_cluster_funnel_tier1,
    "thesis_with_universe": gen_scout_thesis_long_with_universe_match,
    "bear_regime_tier1": gen_scout_bear_regime_conservative,
    "flow_only_vol_fail": gen_scout_flow_only_vol_fail,
    "flow_only_mcap_fail": gen_scout_flow_only_mcap_fail,
}

# Weighted distribution: teach the edge cases more frequently
SCOUT_WEIGHTS = {
    "mover_skip": 12,
    "surge_skip": 8,
    "tier1_multi_signal": 10,
    "flow_only_above": 10,
    "flow_only_below_ratio": 8,
    "flow_only_boundary_34": 6,
    "flow_only_boundary_35": 6,
    "flow_only_liq_below": 6,
    "quality_gate_liq_fail": 8,
    "quality_gate_liq_99k": 5,
    "quality_gate_liq_101k": 5,
    "quality_gate_mcap_fail": 5,
    "quality_gate_vol_fail": 5,
    "pump_filter_above_300": 8,
    "pump_filter_boundary_299": 5,
    "pump_filter_boundary_301": 5,
    "thesis_exception_66": 6,
    "thesis_exception_64": 5,
    "thesis_exception_65": 5,
    "tier2_single_signal": 12,
    "not_in_universe_no_thesis": 6,
    "mover_with_pre_pump": 8,
    "flow_only_max_one": 6,
    "no_signals": 6,
    "accumulation_smart_money": 8,
    "staging_cluster_funnel": 6,
    "thesis_with_universe": 8,
    "bear_regime_tier1": 6,
    "flow_only_vol_fail": 5,
    "flow_only_mcap_fail": 5,
}


def gen_scout_examples(count):
    scenarios = list(SCOUT_SCENARIOS.keys())
    weights = [SCOUT_WEIGHTS[s] for s in scenarios]
    total_w = sum(weights)
    probs = [w / total_w for w in weights]

    examples = []
    for _ in range(count):
        scenario = random.choices(scenarios, weights=probs, k=1)[0]
        user_msg, assistant_msg = SCOUT_SCENARIOS[scenario]()
        example = {
            "messages": [
                {"role": "system", "content": SCOUT_SYSTEM},
                {"role": "user", "content": user_msg},
                {"role": "assistant", "content": assistant_msg},
            ]
        }
        examples.append(example)
    return examples


# ---------------------------------------------------------------------------
# Harvest example builders
# ---------------------------------------------------------------------------

def build_harvest_user(
    sym,
    held_days,
    entry_price,
    current_price,
    pnl_pct,
    change_24h,
    change_7d,
    liq_usd,
    story_signals,   # list of (signal_type, age_h, category) where category is 'pre' or 'post'
    flow_direction,
    flow_ratio,
    n_positions,
    regime,
):
    lines = [
        f"POSITION REVIEW: {sym}",
        f"Held: {held_days}d | Entry: ${entry_price} | Current: ${current_price} | P&L: {pnl_pct}%",
        f"Market: change_24h {change_24h}% | change_7d {change_7d}% | liq ${fmt_k(liq_usd)}",
        "",
        "STORY SIGNALS ON THIS TOKEN:",
    ]
    if story_signals:
        for (stype, age_h, cat) in story_signals:
            lines.append(f"- {stype} (age: {age_h}h) — {cat}-pump")
    else:
        lines.append("- None")

    lines += [
        "",
        f"FLOW: {flow_direction} | ratio {flow_ratio}x",
        f"PORTFOLIO: {n_positions} positions | regime: {regime}",
    ]
    return "\n".join(lines)


def harvest_decision(token, action, reasoning):
    return json.dumps({"token": token, "action": action, "reasoning": reasoning})


def rand_entry_current(pnl_pct):
    """Return (entry_price, current_price) consistent with pnl_pct."""
    entry = round(random.uniform(0.05, 20.0), 4)
    current = round(entry * (1 + pnl_pct / 100), 4)
    return entry, current


# --- Harvest scenario generators ---

def gen_harvest_pump_exhaustion_exit(sym=None):
    """MOVER or SURGE on held position — exit."""
    sym = sym or pick_sym()
    pnl = rand_pct(5, 60)
    entry, current = rand_entry_current(pnl)
    signal = random.choice(POST_PUMP_SIGNALS)
    age_h = signal_age_h()
    change_24h = rand_pct(15, 80)
    change_7d = rand_pct(50, 300)
    liq = rand_k(200, 3000)

    user = build_harvest_user(
        sym, random.randint(1, 14), entry, current, round(pnl, 2),
        change_24h, change_7d, liq,
        [(signal, age_h, "post")],
        "sell", round(random.uniform(0.5, 2.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"{signal} signal at {age_h}h age indicates post-pump exhaustion. P&L +{pnl:.1f}% — exit before dump."
    return user, harvest_decision(sym, "exit", reasoning)


def gen_harvest_mover_surge_profit_exit(sym=None):
    """MOVER + significant profit — clear exit signal."""
    sym = sym or pick_sym()
    pnl = rand_pct(15, 80)
    entry, current = rand_entry_current(pnl)
    age_h = signal_age_h()
    change_24h = rand_pct(20, 100)
    liq = rand_k(300, 5000)

    user = build_harvest_user(
        sym, random.randint(1, 10), entry, current, round(pnl, 2),
        change_24h, rand_pct(40, 250), liq,
        [("MOVER", age_h, "post")],
        "sell", round(random.uniform(1.5, 4.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"MOVER post-pump + P&L +{pnl:.1f}%. Textbook pump exhaustion. Exit immediately."
    return user, harvest_decision(sym, "exit", reasoning)


def gen_harvest_hold_confirm_staging(sym=None):
    """STAGING still active — hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-5, 12)
    entry, current = rand_entry_current(pnl)
    age_h = signal_age_h()
    change_24h = rand_pct(-5, 10)
    change_7d = rand_pct(-20, 40)
    liq = rand_k(150, 2000)

    user = build_harvest_user(
        sym, random.randint(1, 7), entry, current, round(pnl, 2),
        change_24h, change_7d, liq,
        [("STAGING", age_h, "pre")],
        "buy", round(random.uniform(1.5, 4.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"STAGING signal still active ({age_h}h). Pre-pump thesis intact. Hold position."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_hold_confirm_cluster(sym=None):
    """CLUSTER still active — hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-4, 10)
    entry, current = rand_entry_current(pnl)
    age_h = signal_age_h()
    liq = rand_k(200, 3000)

    user = build_harvest_user(
        sym, random.randint(1, 10), entry, current, round(pnl, 2),
        rand_pct(-4, 8), rand_pct(-15, 30), liq,
        [("CLUSTER", age_h, "pre")],
        "buy", round(random.uniform(2.0, 5.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"CLUSTER signal active ({age_h}h). Wallet cohort still building. Hold."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_hold_confirm_accumulation_smart_money(sym=None):
    """ACCUMULATION + SMART_MONEY active — strong hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-6, 15)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(300, 5000)

    user = build_harvest_user(
        sym, random.randint(1, 14), entry, current, round(pnl, 2),
        rand_pct(-3, 8), rand_pct(-20, 60), liq,
        [("ACCUMULATION", signal_age_h(), "pre"), ("SMART_MONEY", signal_age_h(), "pre")],
        "buy", round(random.uniform(2.5, 5.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "ACCUMULATION + SMART_MONEY both active. Institutional buying confirmed. Strong hold."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_stop_loss_exit(sym=None):
    """Unrealized PnL <= -8% and no positive signals — stop loss exit."""
    sym = sym or pick_sym()
    pnl = rand_pct(-25, -8)
    entry, current = rand_entry_current(pnl)
    change_24h = rand_pct(-15, -2)
    change_7d = rand_pct(-40, -5)
    liq = rand_k(50, 500)

    user = build_harvest_user(
        sym, random.randint(1, 20), entry, current, round(pnl, 2),
        change_24h, change_7d, liq,
        [],  # no active signals
        "sell", round(random.uniform(0.3, 1.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"Stop loss: P&L {pnl:.1f}% <= -8% with no active positive signals. Exit to preserve capital."
    return user, harvest_decision(sym, "exit", reasoning)


def gen_harvest_stop_loss_boundary_minus8(sym=None):
    """PnL exactly -8% — stop loss triggers."""
    sym = sym or pick_sym()
    pnl = -8.0
    entry, current = rand_entry_current(pnl)
    liq = rand_k(100, 600)

    user = build_harvest_user(
        sym, random.randint(2, 15), entry, current, pnl,
        rand_pct(-10, -1), rand_pct(-25, -3), liq,
        [],
        "sell", round(random.uniform(0.5, 1.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "P&L exactly -8.0% — stop loss threshold reached, no active signals. Exit."
    return user, harvest_decision(sym, "exit", reasoning)


def gen_harvest_stop_loss_boundary_minus7_9(sym=None):
    """PnL exactly -7.9% — just above stop loss, no signals but hold."""
    sym = sym or pick_sym()
    pnl = -7.9
    entry, current = rand_entry_current(pnl)
    liq = rand_k(100, 600)

    user = build_harvest_user(
        sym, random.randint(1, 10), entry, current, pnl,
        rand_pct(-8, 0), rand_pct(-20, 0), liq,
        [("STAGING", signal_age_h(), "pre")],  # signal still active
        "neutral", round(random.uniform(1.0, 2.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "P&L -7.9% — above -8% stop loss. STAGING still active. Hold and monitor closely."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_profit_exit_with_pump(sym=None):
    """PnL >= 15% AND MOVER/SURGE — exit/trim."""
    sym = sym or pick_sym()
    pnl = rand_pct(15, 60)
    entry, current = rand_entry_current(pnl)
    signal = random.choice(POST_PUMP_SIGNALS)
    age_h = signal_age_h()
    change_24h = rand_pct(10, 60)
    change_7d = rand_pct(30, 200)
    liq = rand_k(200, 3000)

    user = build_harvest_user(
        sym, random.randint(1, 20), entry, current, round(pnl, 2),
        change_24h, change_7d, liq,
        [(signal, age_h, "post")],
        "sell", round(random.uniform(1.5, 4.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    action = random.choice(["exit", "trim"])
    reasoning = f"P&L +{pnl:.1f}% >= 15% profit target AND {signal} post-pump signal. {action.capitalize()} position."
    return user, harvest_decision(sym, action, reasoning)


def gen_harvest_profit_boundary_15_no_pump(sym=None):
    """PnL exactly 15% but no pump signal — hold (need both conditions)."""
    sym = sym or pick_sym()
    pnl = 15.0
    entry, current = rand_entry_current(pnl)
    liq = rand_k(200, 1500)

    user = build_harvest_user(
        sym, random.randint(2, 15), entry, current, pnl,
        rand_pct(-2, 8), rand_pct(-10, 40), liq,
        [("ACCUMULATION", signal_age_h(), "pre")],  # pre-pump only, no post-pump
        "buy", round(random.uniform(1.5, 3.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "P&L +15% hits profit target but no pump signal (MOVER/SURGE). ACCUMULATION still active. Hold."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_stale_monitor(sym=None):
    """Position flat 3+ days, no active signals — monitor."""
    sym = sym or pick_sym()
    pnl = rand_pct(-4, 5)
    entry, current = rand_entry_current(pnl)
    held_days = random.randint(3, 14)
    change_24h = rand_pct(-2, 2)
    change_7d = rand_pct(-5, 10)
    liq = rand_k(80, 500)

    user = build_harvest_user(
        sym, held_days, entry, current, round(pnl, 2),
        change_24h, change_7d, liq,
        [],  # no signals
        "neutral", round(random.uniform(0.8, 2.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"Position flat {held_days}d, no active signals. Mark as stale. Monitor for new catalyst."
    return user, harvest_decision(sym, "monitor", reasoning)


def gen_harvest_strong_conviction_hold(sym=None):
    """change_7d < 200%, pre-pump signals active — strong hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-5, 10)
    entry, current = rand_entry_current(pnl)
    change_7d = rand_pct(-30, 199)   # < 200%
    liq = rand_k(200, 3000)
    sigs = random.sample(PRE_PUMP_SIGNALS, k=random.randint(1, 3))
    signal_data = [(s, signal_age_h(), "pre") for s in sigs]

    user = build_harvest_user(
        sym, random.randint(1, 10), entry, current, round(pnl, 2),
        rand_pct(-5, 10), change_7d, liq,
        signal_data,
        "buy", round(random.uniform(2.0, 5.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    sig_names = "+".join(sigs)
    reasoning = f"7d change {change_7d:.1f}% < 200% — not pumped out. {sig_names} still active. Strong hold."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_strong_conviction_boundary_199(sym=None):
    """change_7d exactly 199% with pre-pump signals — strong hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-3, 12)
    entry, current = rand_entry_current(pnl)
    change_7d = 199.0
    liq = rand_k(200, 2000)
    sig = random.choice(PRE_PUMP_SIGNALS)

    user = build_harvest_user(
        sym, random.randint(1, 12), entry, current, round(pnl, 2),
        rand_pct(-3, 8), change_7d, liq,
        [(sig, signal_age_h(), "pre")],
        "buy", round(random.uniform(2.0, 4.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"7d change 199% — just below 200% threshold. {sig} still active. Hold per strong-conviction rule."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_strong_conviction_boundary_200(sym=None):
    """change_7d exactly 200% — at threshold, be cautious."""
    sym = sym or pick_sym()
    pnl = rand_pct(5, 25)
    entry, current = rand_entry_current(pnl)
    change_7d = 200.0
    liq = rand_k(200, 2000)
    sig = random.choice(PRE_PUMP_SIGNALS)

    user = build_harvest_user(
        sym, random.randint(2, 15), entry, current, round(pnl, 2),
        rand_pct(5, 30), change_7d, liq,
        [(sig, signal_age_h(), "pre")],
        "neutral", round(random.uniform(1.5, 3.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"7d change 200% — at threshold. {sig} still active but move is maturing. Monitor for pump signals."
    return user, harvest_decision(sym, "monitor", reasoning)


def gen_harvest_exit_deep_loss_no_signals(sym=None):
    """Deep loss -15%+ with no signals — exit."""
    sym = sym or pick_sym()
    pnl = rand_pct(-40, -15)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(30, 300)

    user = build_harvest_user(
        sym, random.randint(3, 30), entry, current, round(pnl, 2),
        rand_pct(-20, -5), rand_pct(-50, -15), liq,
        [],
        "sell", round(random.uniform(0.2, 1.0), 1),
        random.randint(3, 9), random.choice(REGIMES),
    )
    reasoning = f"Deep loss {pnl:.1f}%. No active signals. Thesis has failed. Exit and free capital."
    return user, harvest_decision(sym, "exit", reasoning)


def gen_harvest_trim_large_profit_no_pump_yet(sym=None):
    """Large profit 30%+ but no pump signal yet — trim to lock in gains."""
    sym = sym or pick_sym()
    pnl = rand_pct(30, 80)
    entry, current = rand_entry_current(pnl)
    sig = random.choice(PRE_PUMP_SIGNALS)
    liq = rand_k(300, 5000)

    user = build_harvest_user(
        sym, random.randint(3, 20), entry, current, round(pnl, 2),
        rand_pct(5, 20), rand_pct(50, 150), liq,
        [(sig, signal_age_h(), "pre")],
        "buy", round(random.uniform(2.0, 5.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"P&L +{pnl:.1f}% — substantial gains. {sig} still active. Trim 50% to lock profits, hold rest."
    return user, harvest_decision(sym, "trim", reasoning)


def gen_harvest_hold_with_funnel_new_wallets(sym=None):
    """FUNNEL + NEW_WALLETS active — hold, accumulation in progress."""
    sym = sym or pick_sym()
    pnl = rand_pct(-5, 8)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(150, 2000)

    user = build_harvest_user(
        sym, random.randint(1, 8), entry, current, round(pnl, 2),
        rand_pct(-4, 8), rand_pct(-20, 50), liq,
        [("FUNNEL", signal_age_h(), "pre"), ("NEW_WALLETS", signal_age_h(), "pre")],
        "buy", round(random.uniform(2.0, 5.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "FUNNEL + NEW_WALLETS both active. Fresh wallet cohort entering. Accumulation ongoing. Hold."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_exit_surge_with_loss(sym=None):
    """SURGE on token but position is losing — still exit (post-pump)."""
    sym = sym or pick_sym()
    pnl = rand_pct(-15, -1)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(100, 1000)

    user = build_harvest_user(
        sym, random.randint(1, 20), entry, current, round(pnl, 2),
        rand_pct(20, 80), rand_pct(30, 150), liq,
        [("SURGE", signal_age_h(), "post")],
        "sell", round(random.uniform(2.0, 5.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"SURGE on losing position ({pnl:.1f}%). Post-pump signal — likely temporary spike, cut loss."
    return user, harvest_decision(sym, "exit", reasoning)


def gen_harvest_stale_boundary_2days(sym=None):
    """Held 2 days no signals — not yet stale, hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-3, 5)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(100, 800)

    user = build_harvest_user(
        sym, 2, entry, current, round(pnl, 2),
        rand_pct(-2, 3), rand_pct(-5, 15), liq,
        [],
        "neutral", round(random.uniform(1.0, 2.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "Held 2d, no signals — not yet stale (threshold 3d). Hold one more day before marking stale."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_stale_boundary_3days(sym=None):
    """Held 3 days no signals — stale, monitor."""
    sym = sym or pick_sym()
    pnl = rand_pct(-3, 4)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(100, 800)

    user = build_harvest_user(
        sym, 3, entry, current, round(pnl, 2),
        rand_pct(-2, 2), rand_pct(-6, 10), liq,
        [],
        "neutral", round(random.uniform(0.8, 2.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = "Held exactly 3d with no active signals — stale threshold reached. Monitor for re-entry signals."
    return user, harvest_decision(sym, "monitor", reasoning)


def gen_harvest_multiple_pre_pump_strong_hold(sym=None):
    """Multiple pre-pump signals, modest P&L — strong hold."""
    sym = sym or pick_sym()
    pnl = rand_pct(-5, 18)
    entry, current = rand_entry_current(pnl)
    sigs = random.sample(PRE_PUMP_SIGNALS, k=random.randint(2, 4))
    signal_data = [(s, signal_age_h(), "pre") for s in sigs]
    liq = rand_k(200, 4000)

    user = build_harvest_user(
        sym, random.randint(1, 12), entry, current, round(pnl, 2),
        rand_pct(-4, 10), rand_pct(-20, 80), liq,
        signal_data,
        "buy", round(random.uniform(2.5, 6.0), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    sig_names = ", ".join(sigs)
    reasoning = f"Multiple pre-pump signals active: {sig_names}. Thesis strongly intact. Hold full position."
    return user, harvest_decision(sym, "hold", reasoning)


def gen_harvest_exit_stop_loss_with_signal_fading(sym=None):
    """Below -8% AND signals fading — exit."""
    sym = sym or pick_sym()
    pnl = rand_pct(-20, -8.1)
    entry, current = rand_entry_current(pnl)
    liq = rand_k(50, 400)

    user = build_harvest_user(
        sym, random.randint(2, 25), entry, current, round(pnl, 2),
        rand_pct(-15, -3), rand_pct(-35, -8), liq,
        [],  # signals gone
        "sell", round(random.uniform(0.3, 1.5), 1),
        random.randint(2, 8), random.choice(REGIMES),
    )
    reasoning = f"P&L {pnl:.1f}% — stop loss breached, signals have disappeared. Exit position."
    return user, harvest_decision(sym, "exit", reasoning)


# Map scenario name -> generator
HARVEST_SCENARIOS = {
    "pump_exhaustion_exit": gen_harvest_pump_exhaustion_exit,
    "mover_surge_profit_exit": gen_harvest_mover_surge_profit_exit,
    "hold_confirm_staging": gen_harvest_hold_confirm_staging,
    "hold_confirm_cluster": gen_harvest_hold_confirm_cluster,
    "hold_confirm_accum_smart": gen_harvest_hold_confirm_accumulation_smart_money,
    "stop_loss_exit": gen_harvest_stop_loss_exit,
    "stop_loss_boundary_minus8": gen_harvest_stop_loss_boundary_minus8,
    "stop_loss_boundary_minus7_9": gen_harvest_stop_loss_boundary_minus7_9,
    "profit_exit_with_pump": gen_harvest_profit_exit_with_pump,
    "profit_15_no_pump": gen_harvest_profit_boundary_15_no_pump,
    "stale_monitor": gen_harvest_stale_monitor,
    "strong_conviction_hold": gen_harvest_strong_conviction_hold,
    "strong_conviction_boundary_199": gen_harvest_strong_conviction_boundary_199,
    "strong_conviction_boundary_200": gen_harvest_strong_conviction_boundary_200,
    "exit_deep_loss": gen_harvest_exit_deep_loss_no_signals,
    "trim_large_profit": gen_harvest_trim_large_profit_no_pump_yet,
    "hold_funnel_new_wallets": gen_harvest_hold_with_funnel_new_wallets,
    "exit_surge_with_loss": gen_harvest_exit_surge_with_loss,
    "stale_boundary_2days": gen_harvest_stale_boundary_2days,
    "stale_boundary_3days": gen_harvest_stale_boundary_3days,
    "multiple_pre_pump_strong_hold": gen_harvest_multiple_pre_pump_strong_hold,
    "exit_stop_loss_fading": gen_harvest_exit_stop_loss_with_signal_fading,
}

HARVEST_WEIGHTS = {
    "pump_exhaustion_exit": 12,
    "mover_surge_profit_exit": 8,
    "hold_confirm_staging": 10,
    "hold_confirm_cluster": 8,
    "hold_confirm_accum_smart": 8,
    "stop_loss_exit": 10,
    "stop_loss_boundary_minus8": 5,
    "stop_loss_boundary_minus7_9": 5,
    "profit_exit_with_pump": 10,
    "profit_15_no_pump": 5,
    "stale_monitor": 8,
    "strong_conviction_hold": 10,
    "strong_conviction_boundary_199": 5,
    "strong_conviction_boundary_200": 5,
    "exit_deep_loss": 8,
    "trim_large_profit": 6,
    "hold_funnel_new_wallets": 8,
    "exit_surge_with_loss": 6,
    "stale_boundary_2days": 5,
    "stale_boundary_3days": 5,
    "multiple_pre_pump_strong_hold": 10,
    "exit_stop_loss_fading": 8,
}


def gen_harvest_examples(count):
    scenarios = list(HARVEST_SCENARIOS.keys())
    weights = [HARVEST_WEIGHTS[s] for s in scenarios]
    total_w = sum(weights)
    probs = [w / total_w for w in weights]

    examples = []
    for _ in range(count):
        scenario = random.choices(scenarios, weights=probs, k=1)[0]
        user_msg, assistant_msg = HARVEST_SCENARIOS[scenario]()
        example = {
            "messages": [
                {"role": "system", "content": HARVEST_SYSTEM},
                {"role": "user", "content": user_msg},
                {"role": "assistant", "content": assistant_msg},
            ]
        }
        examples.append(example)
    return examples


# ---------------------------------------------------------------------------
# Split and write
# ---------------------------------------------------------------------------

def split_90_5_5(examples):
    random.shuffle(examples)
    n = len(examples)
    n_train = math.floor(n * 0.90)
    n_valid = math.floor(n * 0.05)
    train = examples[:n_train]
    valid = examples[n_train:n_train + n_valid]
    test = examples[n_train + n_valid:]
    return train, valid, test


def write_jsonl(path, examples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")


def write_agent_splits(output_dir, agent_name, examples):
    agent_dir = os.path.join(output_dir, agent_name)
    os.makedirs(agent_dir, exist_ok=True)
    train, valid, test = split_90_5_5(examples)
    write_jsonl(os.path.join(agent_dir, "train.jsonl"), train)
    write_jsonl(os.path.join(agent_dir, "valid.jsonl"), valid)
    write_jsonl(os.path.join(agent_dir, "test.jsonl"), test)
    return len(train), len(valid), len(test)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Generate synthetic training data for Scout and Harvest agents."
    )
    parser.add_argument(
        "--agent", choices=["scout", "harvest", "all"], default="all",
        help="Which agent to generate data for (default: all)"
    )
    parser.add_argument(
        "--count", type=int, default=300,
        help="Number of examples per agent (default: 300; harvest gets 200 if using 'all')"
    )
    parser.add_argument(
        "--output", type=str, default="data/",
        help="Output directory (default: data/)"
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)"
    )
    args = parser.parse_args()

    random.seed(args.seed)

    output_dir = args.output.rstrip("/")
    n_scout = 0
    n_harvest = 0

    if args.agent in ("scout", "all"):
        scout_count = args.count if args.agent == "scout" else max(args.count, 300)
        print(f"Generating {scout_count} scout examples...")
        scout_examples = gen_scout_examples(scout_count)
        tr, va, te = write_agent_splits(output_dir, "scout", scout_examples)
        n_scout = len(scout_examples)
        print(f"  Scout: {tr} train / {va} valid / {te} test -> {output_dir}/scout/")

    if args.agent in ("harvest", "all"):
        harvest_count = args.count if args.agent == "harvest" else max(args.count, 200)
        # If 'all', harvest gets 200 minimum unless --count > 200
        if args.agent == "all":
            harvest_count = max(200, args.count * 2 // 3)
        print(f"Generating {harvest_count} harvest examples...")
        harvest_examples = gen_harvest_examples(harvest_count)
        tr, va, te = write_agent_splits(output_dir, "harvest", harvest_examples)
        n_harvest = len(harvest_examples)
        print(f"  Harvest: {tr} train / {va} valid / {te} test -> {output_dir}/harvest/")

    print(f"\nGenerated {n_scout} scout examples, {n_harvest} harvest examples -> {output_dir}")


if __name__ == "__main__":
    main()
