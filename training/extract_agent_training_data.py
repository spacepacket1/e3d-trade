#!/usr/bin/env python3
"""
Extract training data from E3D trading pipeline logs for Scout and Harvest LoRA adapters.

Usage:
    python3 extract_agent_training_data.py \
        --log /path/to/training-events.jsonl \
        --agent scout|harvest|all \
        --since 2026-04-01 \
        --output ./data \
        --min-examples 10
"""

import argparse
import json
import os
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fmt_usd(value, divisor=1, suffix=""):
    """Format a USD value compactly (M, k, raw)."""
    if value is None:
        return "N/A"
    try:
        v = float(value) / divisor
    except (TypeError, ValueError):
        return str(value)
    if abs(v) >= 1_000_000:
        return f"${v / 1_000_000:.2f}M{suffix}"
    if abs(v) >= 1_000:
        return f"${v / 1_000:.1f}k{suffix}"
    return f"${v:.4g}{suffix}"


def _pct(value):
    if value is None:
        return "N/A"
    try:
        return f"{float(value):.2f}%"
    except (TypeError, ValueError):
        return str(value)


def _parse_ts(ts_str):
    """Parse ISO timestamp string to datetime (timezone-aware)."""
    if not ts_str:
        return None
    try:
        # Handle both Z suffix and +HH:MM offset
        ts_str = ts_str.replace("Z", "+00:00")
        return datetime.fromisoformat(ts_str)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Log loading
# ---------------------------------------------------------------------------

def load_events(log_path: Path, since: datetime | None) -> tuple[list[dict], int]:
    """
    Load all events from a JSONL file.

    Returns (events, malformed_count).
    Events are optionally filtered by timestamp >= since.
    """
    events = []
    malformed = 0

    try:
        with open(log_path, "r", encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError as exc:
                    malformed += 1
                    print(
                        f"[WARN] Line {lineno}: malformed JSON ({exc}), skipping.",
                        file=sys.stderr,
                    )
                    continue

                if since is not None:
                    ts = _parse_ts(event.get("ts", ""))
                    if ts is not None and ts < since:
                        continue

                events.append(event)

    except FileNotFoundError:
        print(f"[ERROR] Log file not found: {log_path}", file=sys.stderr)
        sys.exit(1)

    return events, malformed


# ---------------------------------------------------------------------------
# Index building
# ---------------------------------------------------------------------------

def build_index(events: list[dict]) -> dict:
    """
    Build lookup structures for fast event correlation:

        index["candidates"]        : (pipeline_run_id, candidate_id) -> event
        index["risk_decisions"]    : (pipeline_run_id, candidate_id) -> event
                                     fallback: candidate_id -> [events]
        index["outcomes"]          : candidate_id -> [events]  (cross-run)
        index["harvest_decisions"] : candidate_id -> [events]
    """
    idx: dict = {
        "candidates": {},          # (run, cid) -> event
        "risk_decisions": {},      # (run, cid) -> event  (primary)
        "risk_decisions_by_cid": defaultdict(list),  # cid -> [event] (fallback)
        "outcomes": defaultdict(list),               # cid -> [event]
        "harvest_decisions": defaultdict(list),      # cid -> [event]
    }

    for event in events:
        et = event.get("event_type")
        run = event.get("pipeline_run_id")
        cid = event.get("candidate_id")

        if et == "candidate" and cid:
            idx["candidates"][(run, cid)] = event

        elif et == "risk_decision" and cid:
            idx["risk_decisions"][(run, cid)] = event
            idx["risk_decisions_by_cid"][cid].append(event)

        elif et == "outcome" and cid:
            idx["outcomes"][cid].append(event)

        elif et == "harvest_decision" and cid:
            idx["harvest_decisions"][cid].append(event)

    return idx


def lookup_risk_decision(idx: dict, run_id: str, cid: str) -> dict | None:
    """Find risk decision; prefer same run, fall back to any run."""
    rd = idx["risk_decisions"].get((run_id, cid))
    if rd:
        return rd
    # Fallback: if candidate was re-proposed in a later run that produced a decision
    fallbacks = idx["risk_decisions_by_cid"].get(cid, [])
    if fallbacks:
        # Return the one closest in time to the candidate (first by list order)
        return fallbacks[0]
    return None


def lookup_latest_outcome(idx: dict, cid: str) -> dict | None:
    """Return the most recent outcome event for a candidate_id, or None."""
    outcomes = idx["outcomes"].get(cid, [])
    if not outcomes:
        return None
    # Sort by timestamp descending — last recorded outcome wins
    def _ts(e):
        return _parse_ts(e.get("ts", "")) or datetime.min.replace(tzinfo=timezone.utc)
    return max(outcomes, key=_ts)


# ---------------------------------------------------------------------------
# Scout training data extraction
# ---------------------------------------------------------------------------

def _build_scout_user_message(candidate_event: dict, risk_event: dict) -> str:
    """Build the compressed user-message for a scout training example."""
    cp = candidate_event.get("payload", {})
    rp = risk_event.get("payload", {})

    ts = candidate_event.get("ts", "unknown")

    # Portfolio context from candidate
    pi = cp.get("portfolio_intelligence", {})
    regime = pi.get("market_regime") or candidate_event.get("market_regime", "unknown")
    portfolio = pi.get("portfolio", {})
    cash = portfolio.get("cash_usd", cp.get("portfolio_snapshot", {}).get("cash_usd", 0))
    equity = portfolio.get("equity_usd", cp.get("portfolio_snapshot", {}).get("equity_usd", 0))
    ps = cp.get("portfolio_snapshot", {})
    open_pos = ps.get("open_positions", portfolio.get("position_count", 0))

    # Token info
    token = cp.get("token", {})
    symbol = token.get("symbol", "UNKNOWN")
    category = token.get("category", "unknown")

    # Market data
    md = cp.get("market_data") or {}
    price = md.get("current_price", 0)
    chg24 = md.get("change_24h_pct", 0)
    mcap = md.get("market_cap_usd", 0)

    ld = cp.get("liquidity_data") or {}
    liq = ld.get("liquidity_usd", 0)

    ed = cp.get("execution_data") or {}
    slippage = ed.get("estimated_slippage_bps", 0)

    conviction = cp.get("conviction_score", 0)
    opportunity = cp.get("opportunity_score", 0)

    # Why_now and evidence live in the risk_decision proposal
    proposal = rp.get("proposal", {})
    why_now = proposal.get("why_now", cp.get("why_now", ""))
    evidence_list = proposal.get("evidence", cp.get("evidence", []))
    evidence_str = "; ".join(str(e) for e in evidence_list) if evidence_list else "none"

    # Risk assessment
    rr = rp.get("risk_review", {})
    short_summary = rr.get("short_summary", "No summary.")
    reason_codes = rr.get("reason_codes", [])
    codes_str = ", ".join(reason_codes) if reason_codes else "none"

    try:
        price = float(price) if price else 0
        mcap = float(mcap) if mcap else 0
        liq = float(liq) if liq else 0
        chg24 = float(chg24) if chg24 else 0
        slippage = int(slippage) if slippage else 0
        conviction = float(conviction) if conviction else 0
        opportunity = float(opportunity) if opportunity else 0
    except (TypeError, ValueError):
        price = mcap = liq = chg24 = slippage = conviction = opportunity = 0
    price_fmt = f"${price:,.4g}" if price < 1 else f"${price:,.2f}"
    mcap_m = f"{mcap / 1_000_000:.1f}M" if mcap else "N/A"
    liq_k = f"{liq / 1_000:.1f}k" if liq else "N/A"

    lines = [
        f"SCAN: {ts}",
        f"MACRO: {regime} | portfolio: ${cash:,.0f}/${equity:,.0f} | open_positions: {open_pos}",
        "",
        f"TOKEN: {symbol} ({category})",
        f"Market: price {price_fmt} | 24h {_pct(chg24)} | mcap ${mcap_m} | liq ${liq_k} | slippage {slippage}bps",
        f"Conviction: {conviction} | Opportunity: {opportunity}",
        "",
        "SCOUT REASONING:",
        why_now if why_now else "(none)",
        f"Evidence: {evidence_str}",
        "",
        "RISK ASSESSMENT:",
        short_summary,
        f"Reason codes: {codes_str}",
    ]
    return "\n".join(lines)


def _build_scout_positive_output(candidate_event: dict, risk_event: dict) -> dict:
    """Build the assistant output for a positive scout example (buy approved)."""
    cp = candidate_event.get("payload", {})
    rp = risk_event.get("payload", {})
    ts = candidate_event.get("ts", "")

    proposal = rp.get("proposal", {})
    token = proposal.get("token") or cp.get("token", {})
    confidence = proposal.get("confidence", cp.get("conviction_score", 0))
    why_now = proposal.get("why_now", cp.get("why_now", ""))
    evidence = proposal.get("evidence", cp.get("evidence", []))

    return {
        "scan_timestamp": ts,
        "candidates": [
            {
                "token": token,
                "tier": "TIER_2",
                "action": "buy",
                "confidence": confidence,
                "why_now": why_now,
                "evidence": evidence,
            }
        ],
        "stories_checked": [],
    }


def _build_scout_negative_output(candidate_event: dict, risk_event: dict) -> dict:
    """Build the assistant output for a negative scout example (should not buy)."""
    ts = candidate_event.get("ts", "")
    rp = risk_event.get("payload", {})
    rr = rp.get("risk_review", {})
    reason_codes = rr.get("reason_codes", [])
    short_summary = rr.get("short_summary", "")

    # Derive a human-readable skip_reason
    negative_codes = {
        "reject_rug_risk", "reject_liquidity", "reject_slippage",
        "reject_fraud_risk", "reject_cooldown", "reject_position_caps",
        "reject_price_drift", "reject_schema",
    }
    matched = [c for c in reason_codes if "reject" in c.lower() or "invalid" in c.lower()]
    if matched:
        skip_reason = "; ".join(matched)
    elif short_summary:
        # Truncate to first sentence
        skip_reason = short_summary.split(".")[0]
    else:
        skip_reason = "quality gate failure"

    return {
        "scan_timestamp": ts,
        "candidates": [],
        "stories_checked": [],
        "skip_reason": skip_reason,
    }


def extract_scout_examples(idx: dict, events: list[dict]) -> list[dict]:
    """
    Build scout training examples.

    Returns list of dicts with keys: messages, label, confidence, ts
    """
    examples = []

    for (run_id, cid), candidate_event in idx["candidates"].items():
        # 1. Find risk decision
        risk_event = lookup_risk_decision(idx, run_id, cid)
        if risk_event is None:
            print(f"[INFO] Scout: no risk decision for candidate {cid[:10]}... (run {run_id[:8]}), skipping.", file=sys.stderr)
            continue

        rp = risk_event.get("payload", {})
        risk_decision = rp.get("decision", "")

        # 2. Find outcome (cross-run match on candidate_id)
        outcome_event = lookup_latest_outcome(idx, cid)

        # 3. Determine label
        label = None
        confidence = 1.0

        if risk_decision == "reject":
            label = "negative"
        elif risk_decision in ("paper_trade", "approve_for_executor"):
            # Approved — now check outcome
            if outcome_event is None:
                # No outcome yet — position still open, skip
                continue

            pnl = outcome_event["payload"].get("pnl_usd", 0) or 0
            outcome_label = outcome_event["payload"].get("outcome_label", "")

            if pnl > 50:
                label = "positive"
            elif pnl < -50:
                label = "negative"
            elif abs(pnl) < 0.01 and outcome_label == "profit":
                # Paper trading artifact: prices didn't update
                label = "positive"
                confidence = 0.5
            elif pnl < 0:
                # Loss but not severe enough for hard negative threshold
                label = "negative"
                confidence = 0.7
            else:
                # Small positive or near-zero non-paper profit
                label = "positive"
                confidence = 0.6
        else:
            # Unknown decision type
            print(f"[WARN] Scout: unrecognised risk decision '{risk_decision}' for {cid[:10]}..., skipping.", file=sys.stderr)
            continue

        # 4. Build messages
        user_msg = _build_scout_user_message(candidate_event, risk_event)

        if label == "positive":
            assistant_output = _build_scout_positive_output(candidate_event, risk_event)
        else:
            assistant_output = _build_scout_negative_output(candidate_event, risk_event)

        example = {
            "messages": [
                {"role": "system", "content": "You are Scout, an elite crypto trading research agent. Identify high-quality pre-pump entry candidates from on-chain signals. Return STRICT JSON only."},
                {"role": "user", "content": user_msg},
                {"role": "assistant", "content": json.dumps(assistant_output, separators=(",", ":"))},
            ],
            "label": label,
            "confidence": confidence,
            "ts": candidate_event.get("ts", ""),
            "_meta": {
                "agent": "scout",
                "candidate_id": cid,
                "pipeline_run_id": run_id,
                "risk_decision": risk_decision,
                "pnl_usd": (outcome_event["payload"].get("pnl_usd") if outcome_event else None),
            },
        }
        examples.append(example)

    return examples


# ---------------------------------------------------------------------------
# Harvest training data extraction
# ---------------------------------------------------------------------------

def _find_holding_for_candidate(holdings: list[dict], cid: str) -> dict | None:
    """Find the holding in portfolio_intelligence.holdings that matches candidate_id."""
    for h in holdings:
        pos = h.get("position", {})
        contract = pos.get("contract_address", "")
        if contract.lower() == cid.lower():
            return h
        # Also check token field
        tok = h.get("token", {})
        if tok.get("contract_address", "").lower() == cid.lower():
            return h
    return None


def _build_harvest_user_message(harvest_event: dict, holding: dict | None) -> str:
    """Build the compressed user-message for a harvest training example."""
    hp = harvest_event.get("payload", {})
    hr = hp.get("harvest_review", {})
    pi = hp.get("portfolio_intelligence", {})
    portfolio = pi.get("portfolio", {})
    regime = pi.get("market_regime", harvest_event.get("market_regime", "unknown"))

    ts = harvest_event.get("ts", "")

    # Token / position info from harvest_review (most reliable)
    token_info = hr.get("token", {})
    symbol = token_info.get("symbol", "UNKNOWN")
    pos_info = hr.get("position", {})
    entry_price = pos_info.get("avg_entry_price", 0)
    current_price = pos_info.get("current_price", 0)
    cost_basis = pos_info.get("cost_basis_usd", 0)
    market_value = pos_info.get("market_value_usd", 0)
    unrealized_pnl = pos_info.get("unrealized_pnl_usd", 0)

    # Holding days — derive from holding if available, otherwise estimate
    if holding:
        h_pos = holding.get("position", {})
        opened_at = _parse_ts(h_pos.get("opened_at", ""))
        event_ts = _parse_ts(ts)
        if opened_at and event_ts:
            holding_days = (event_ts - opened_at).total_seconds() / 86400
        else:
            holding_days = 0.0
    else:
        holding_days = 0.0

    # Pct P&L
    pnl_pct = ((current_price - entry_price) / entry_price * 100) if entry_price else 0

    # Market data from holding or harvest_review
    if holding:
        md = holding.get("market_data") or {}
    else:
        md = hr.get("market_data") or {}
    chg24 = md.get("change_24h_pct", 0)
    vol24h = md.get("volume_24h_usd", 0)
    mcap = md.get("market_cap_usd", 0)
    liq = md.get("liquidity_usd", 0)

    # Story signals
    story_lines = []
    if holding:
        ss = holding.get("story_snapshot", {})
        top_stories = ss.get("top_stories", [])
        for s in top_stories[:3]:
            tone = s.get("tone", "?")
            stype = s.get("story_type", "?")
            score = s.get("score", 0)
            story_lines.append(f"  [{tone}] {stype} (score={score:.1f})")
    if not story_lines:
        story_lines = ["  (no signal stories)"]

    # Flow
    flow_direction = "unknown"
    counterparty_count = 0
    if holding:
        flow = holding.get("flow", {})
        flow_direction = flow.get("flow_direction", "unknown")
        counterparty_count = flow.get("counterparty_count", 0)

    position_count = portfolio.get("position_count", 0)

    entry_fmt = f"${entry_price:,.4g}" if entry_price < 1 else f"${entry_price:,.2f}"
    current_fmt = f"${current_price:,.4g}" if current_price < 1 else f"${current_price:,.2f}"
    vol24h_k = f"{vol24h / 1_000:.1f}k" if vol24h else "N/A"
    mcap_m = f"{mcap / 1_000_000:.1f}M" if mcap else "N/A"
    liq_k = f"{liq / 1_000:.1f}k" if liq else "N/A"

    lines = [
        f"POSITION REVIEW: {symbol}",
        f"Held: {holding_days:.2f}d | Entry: {entry_fmt} | Current: {current_fmt} | P&L: {pnl_pct:+.2f}%",
        f"Market: 24h {_pct(chg24)} | vol24h ${vol24h_k} | mcap ${mcap_m} | liq ${liq_k}",
        "",
        "STORY SIGNALS:",
    ] + story_lines + [
        "",
        f"FLOW: {flow_direction} | counterparties: {counterparty_count}",
        "",
        f"PORTFOLIO CONTEXT: {position_count} positions | regime: {regime}",
    ]
    return "\n".join(lines)


def _build_harvest_assistant_output(harvest_event: dict) -> dict:
    """Build the assistant output from harvest_review."""
    hp = harvest_event.get("payload", {})
    hr = hp.get("harvest_review", {})
    decision = hp.get("decision", hr.get("action", "monitor"))

    token_info = hr.get("token", {})
    symbol = token_info.get("symbol", "UNKNOWN")
    why_now = hr.get("why_now", "")
    thesis_summary = hr.get("thesis_summary", hr.get("summary", ""))
    reasoning = why_now if why_now else thesis_summary

    return {
        "token": symbol,
        "action": decision,
        "reasoning": reasoning,
    }


def extract_harvest_examples(idx: dict, events: list[dict]) -> list[dict]:
    """
    Build harvest training examples.

    Returns list of dicts with keys: messages, label, confidence, ts
    """
    examples = []

    for cid, harvest_events_list in idx["harvest_decisions"].items():
        for harvest_event in harvest_events_list:
            hp = harvest_event.get("payload", {})
            decision = hp.get("decision", "")

            if not decision:
                continue

            # Get portfolio intelligence and find matching holding
            pi = hp.get("portfolio_intelligence", {})
            holdings = pi.get("holdings", [])
            holding = _find_holding_for_candidate(holdings, cid)

            # Build messages
            user_msg = _build_harvest_user_message(harvest_event, holding)
            assistant_output = _build_harvest_assistant_output(harvest_event)

            # Assign label (simplified — no future outcome lookup for harvest)
            # We label based on decision type; further refinement via outcome
            # correlations would require a second pass (out of scope for now)
            label = decision  # "exit", "hold", "monitor", "trim"

            example = {
                "messages": [
                    {"role": "system", "content": "You are Harvest, an elite crypto portfolio manager. Review held positions and decide to hold, monitor, trim, or exit based on signal state and P&L. Return STRICT JSON only."},
                    {"role": "user", "content": user_msg},
                    {"role": "assistant", "content": json.dumps(assistant_output, separators=(",", ":"))},
                ],
                "label": label,
                "confidence": 1.0,
                "ts": harvest_event.get("ts", ""),
                "_meta": {
                    "agent": "harvest",
                    "candidate_id": cid,
                    "pipeline_run_id": harvest_event.get("pipeline_run_id"),
                    "decision": decision,
                },
            }
            examples.append(example)

    return examples


# ---------------------------------------------------------------------------
# Splitting and writing
# ---------------------------------------------------------------------------

def split_examples(examples: list[dict], seed: int = 42) -> tuple[list, list, list]:
    """Split examples 90/5/5 into train/valid/test."""
    rng = random.Random(seed)
    shuffled = list(examples)
    rng.shuffle(shuffled)
    n = len(shuffled)
    n_valid = max(1, round(n * 0.05))
    n_test = max(1, round(n * 0.05))
    # Don't let valid+test exceed n
    if n_valid + n_test >= n:
        n_valid = max(0, (n - 1) // 2)
        n_test = max(0, n - 1 - n_valid)

    train = shuffled[n_valid + n_test :]
    valid = shuffled[:n_valid]
    test = shuffled[n_valid : n_valid + n_test]
    return train, valid, test


def write_split(examples: list[dict], output_path: Path) -> None:
    """Write a list of examples to a JSONL file, stripping internal _meta keys."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as fh:
        for ex in examples:
            record = {k: v for k, v in ex.items() if not k.startswith("_")}
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# Summary helpers
# ---------------------------------------------------------------------------

def _label_distribution(examples: list[dict]) -> dict[str, int]:
    from collections import Counter
    return dict(Counter(ex.get("label", ex.get("_label", "unknown")) for ex in examples))


def _print_summary(agent: str, examples: list[dict], train: list, valid: list, test: list) -> None:
    dist = _label_distribution(examples)
    dist_str = ", ".join(f"{v} {k}" for k, v in sorted(dist.items()))
    total = len(examples)
    print(
        f"{agent.capitalize()}: {dist_str} → {total} examples "
        f"({len(train)}/{len(valid)}/{len(test)} train/valid/test)"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract LoRA training data from E3D pipeline logs."
    )
    parser.add_argument(
        "--log",
        default="/Users/mini/e3d-agent-trading-floor/logs/training-events.jsonl",
        help="Path to training-events.jsonl",
    )
    parser.add_argument(
        "--agent",
        choices=["scout", "harvest", "all"],
        default="all",
        help="Which agent to extract data for (default: all)",
    )
    parser.add_argument(
        "--since",
        default=None,
        help="Only include events on or after this date (YYYY-MM-DD or ISO8601)",
    )
    parser.add_argument(
        "--output",
        default="./data",
        help="Output directory (default: ./data)",
    )
    parser.add_argument(
        "--min-examples",
        type=int,
        default=10,
        dest="min_examples",
        help="Warn if fewer than this many examples are produced (default: 10)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for train/valid/test split (default: 42)",
    )
    parser.add_argument(
        "--synthetic-count",
        type=int,
        default=300,
        dest="synthetic_count",
        help="Number of synthetic examples to generate and merge per agent (0 to disable, default: 300)",
    )
    parser.add_argument(
        "--synthetic-script",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate_synthetic_training_data.py"),
        dest="synthetic_script",
        help="Path to generate_synthetic_training_data.py",
    )
    return parser.parse_args()


def resolve_since(since_str: str | None) -> datetime | None:
    if not since_str:
        return None
    ts = _parse_ts(since_str)
    if ts is None:
        # Try date-only
        try:
            dt = datetime.strptime(since_str, "%Y-%m-%d")
            ts = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            print(f"[ERROR] Cannot parse --since value: {since_str}", file=sys.stderr)
            sys.exit(1)
    # Make timezone-aware if naive
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def load_synthetic_examples(agent: str, count: int, script_path: str, seed: int) -> list[dict]:
    """Run generate_synthetic_training_data.py and load the results."""
    import subprocess, tempfile
    if not os.path.exists(script_path):
        print(f"[WARN] Synthetic script not found: {script_path}", file=sys.stderr)
        return []
    with tempfile.TemporaryDirectory() as tmpdir:
        cmd = [
            sys.executable, script_path,
            "--agent", agent,
            "--count", str(count),
            "--output", tmpdir,
            "--seed", str(seed),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[WARN] Synthetic generator failed:\n{result.stderr}", file=sys.stderr)
            return []
        # Load all splits back into memory
        examples = []
        for split in ("train", "valid", "test"):
            fp = Path(tmpdir) / agent / f"{split}.jsonl"
            if fp.exists():
                with open(fp) as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                ex = json.loads(line)
                                ex["_label"] = ex.get("label", "synthetic")
                                examples.append(ex)
                            except json.JSONDecodeError:
                                pass
        print(f"[INFO] Loaded {len(examples)} synthetic {agent} examples.", file=sys.stderr)
        return examples


def main() -> None:
    args = parse_args()

    log_path = Path(args.log)
    output_dir = Path(args.output)
    since = resolve_since(args.since)

    # -----------------------------------------------------------------------
    # Load and index
    # -----------------------------------------------------------------------
    print(f"[INFO] Loading events from {log_path} ...", file=sys.stderr)
    events, malformed = load_events(log_path, since)
    if malformed:
        print(f"[WARN] {malformed} malformed line(s) skipped.", file=sys.stderr)
    print(f"[INFO] Loaded {len(events)} events.", file=sys.stderr)

    idx = build_index(events)
    print(
        f"[INFO] Index: {len(idx['candidates'])} candidates, "
        f"{len(idx['risk_decisions'])} risk decisions, "
        f"{sum(len(v) for v in idx['outcomes'].values())} outcomes, "
        f"{sum(len(v) for v in idx['harvest_decisions'].values())} harvest decisions.",
        file=sys.stderr,
    )

    run_scout = args.agent in ("scout", "all")
    run_harvest = args.agent in ("harvest", "all")

    # -----------------------------------------------------------------------
    # Scout
    # -----------------------------------------------------------------------
    if run_scout:
        print("[INFO] Extracting scout examples ...", file=sys.stderr)
        scout_examples = extract_scout_examples(idx, events)
        print(f"[INFO] Scout: {len(scout_examples)} pipeline examples.", file=sys.stderr)

        if args.synthetic_count > 0:
            synth = load_synthetic_examples("scout", args.synthetic_count, args.synthetic_script, args.seed)
            scout_examples = scout_examples + synth

        if len(scout_examples) < args.min_examples:
            print(
                f"[WARN] Scout has only {len(scout_examples)} examples "
                f"(minimum requested: {args.min_examples}).",
                file=sys.stderr,
            )

        train, valid, test = split_examples(scout_examples, seed=args.seed)

        scout_dir = output_dir / "scout"
        write_split(train, scout_dir / "train.jsonl")
        write_split(valid, scout_dir / "valid.jsonl")
        write_split(test, scout_dir / "test.jsonl")
        print(f"[INFO] Scout data written to {scout_dir}/", file=sys.stderr)

        _print_summary("scout", scout_examples, train, valid, test)

    # -----------------------------------------------------------------------
    # Harvest
    # -----------------------------------------------------------------------
    if run_harvest:
        print("[INFO] Extracting harvest examples ...", file=sys.stderr)
        harvest_examples = extract_harvest_examples(idx, events)
        print(f"[INFO] Harvest: {len(harvest_examples)} pipeline examples.", file=sys.stderr)

        if args.synthetic_count > 0:
            synth = load_synthetic_examples("harvest", args.synthetic_count, args.synthetic_script, args.seed)
            harvest_examples = harvest_examples + synth

        if len(harvest_examples) < args.min_examples:
            print(
                f"[WARN] Harvest has only {len(harvest_examples)} examples "
                f"(minimum requested: {args.min_examples}).",
                file=sys.stderr,
            )

        train, valid, test = split_examples(harvest_examples, seed=args.seed)

        harvest_dir = output_dir / "harvest"
        write_split(train, harvest_dir / "train.jsonl")
        write_split(valid, harvest_dir / "valid.jsonl")
        write_split(test, harvest_dir / "test.jsonl")
        print(f"[INFO] Harvest data written to {harvest_dir}/", file=sys.stderr)

        _print_summary("harvest", harvest_examples, train, valid, test)


if __name__ == "__main__":
    main()
