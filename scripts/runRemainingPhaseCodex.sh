#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/Users/mini/e3d-agent-trading-floor}"
CODEX_BIN="${CODEX_BIN:-codex}"
SANDBOX_MODE="${SANDBOX_MODE:-workspace-write}"
APPROVAL_POLICY="${APPROVAL_POLICY:-on-request}"
MODE="${MODE:-exec}"
DEFAULT_START_PHASE="${DEFAULT_START_PHASE:-9}"
END_PHASE="${END_PHASE:-14}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runRemainingPhaseCodex.sh <phase-number|all> [--dry-run] [--from <phase-number>]

Examples:
  scripts/runRemainingPhaseCodex.sh 5
  scripts/runRemainingPhaseCodex.sh 8 --dry-run
  scripts/runRemainingPhaseCodex.sh all
  scripts/runRemainingPhaseCodex.sh all --from 10

Environment overrides:
  ROOT_DIR=/path/to/repo
  CODEX_BIN=/path/to/codex
  SANDBOX_MODE=workspace-write
  APPROVAL_POLICY=on-request
  MODE=exec
  DEFAULT_START_PHASE=9
  END_PHASE=14

Notes:
  - Each phase starts a fresh non-interactive Codex session.
  - "all" resumes from DEFAULT_START_PHASE through END_PHASE. The default is 9 because Phases 5-8 were already run.
  - Use --from to resume after a rate limit or failed phase without rerunning completed phases.
  - The prompts keep live trading disabled and tell Codex not to touch node_modules.
USAGE
}

phase_title() {
  case "$1" in
    5) echo "Portfolio and Strategy Risk Engine" ;;
    6) echo "Crypto Venue, Wallet, Custody, and Key-Management Controls" ;;
    7) echo "Token and Smart-Contract Risk Scanner" ;;
    8) echo "Liquidity, Routing, MEV, and Gas-Aware Execution Controls" ;;
    9) echo "Data Quality and Market Data Normalization" ;;
    10) echo "Signal Attribution and Expectancy Analytics" ;;
    11) echo "Operations, Monitoring, Alerting, and Incident Review" ;;
    12) echo "Reconciliation, Accounting, and Tax-Lot Exports" ;;
    13) echo "Compliance-Style Audit Trail and Operator Permissions" ;;
    14) echo "Professional Dashboard Upgrades" ;;
    *) echo "Unknown phase" ;;
  esac
}

phase_model() {
  case "$1" in
    5) echo "gpt-5.4" ;;
    6) echo "gpt-5.5" ;;
    7) echo "gpt-5.4" ;;
    8) echo "gpt-5.5" ;;
    9) echo "gpt-5.4" ;;
    10) echo "gpt-5.4" ;;
    11) echo "gpt-5.4" ;;
    12) echo "gpt-5.5" ;;
    13) echo "gpt-5.5" ;;
    14) echo "gpt-5.4" ;;
    *) return 1 ;;
  esac
}

common_header() {
  local phase="$1"
  local title
  title="$(phase_title "$phase")"
  cat <<EOF
We are in ${ROOT_DIR}.

Please implement Phase ${phase} from docs/professional-crypto-trading-system-feature-ticket-20260428.md:
${title}.

Keep changes scoped. Preserve existing behavior. Do not touch node_modules. Do not enable live trading. Do not implement later phases.

Start by reading:
- docs/professional-crypto-trading-system-feature-ticket-20260428.md
- pipeline.js
- scripts/orderLifecycle.js
- scripts/riskEngine.js
- scripts/custodyControls.js
- scripts/tokenRiskScanner.js
- scripts/liquidityExecutionControls.js
- scripts/backtestReplay.js
- scripts/executionSimulator.js
- scripts/performanceDaily.js
- scripts/promotionGates.js
- server.js
- package.json

Context:
Earlier phases added historical replay/backtesting, promotion gates, execution simulation, and deterministic order lifecycle representation. This phase should build on that work without replacing it.
If this is a resume after a rate limit or interrupted run, first inspect the current working tree and continue the interrupted phase rather than restarting completed work.

General acceptance criteria:
- No live order submission is possible.
- Backtest/replay must not mutate portfolio.json unless the user explicitly asks for a paper-mode pipeline run.
- Existing paper trading behavior is preserved unless explicit metadata/audit output is added.
- Outputs are deterministic and auditable.
- Reports/API integration is allowed only when small and clearly scoped.
- Update tests/checks as appropriate.
- Run verification before finishing.

EOF
}

phase_prompt() {
  local phase="$1"
  common_header "$phase"
  case "$phase" in
    5)
      cat <<'EOF'
Goal:
Create a deterministic local risk engine for research/paper/shadow order intents. This is an audit and decision layer, not live trading infrastructure.

Expected output:
- A reusable module such as scripts/riskEngine.js.
- Stable risk_decision_id values.
- Risk decisions linked to order_id/trade_id/source_trade_id where applicable.
- Policy version, input snapshot hash, decision, reason codes, blockers/warnings, and checked limits.
- Replay/order records can reference risk decisions.
- Pipeline paper trades can carry risk decision metadata only if integration is small and safe.

Scoped controls:
- daily realized loss limit
- daily total equity drawdown limit
- rolling 24h loss limit
- maximum position size
- maximum token exposure
- maximum category exposure
- maximum strategy exposure
- maximum open positions
- maximum daily turnover
- cooldown after stop loss
- cooldown after strategy-level loss cluster
- new-buy block during negative expectancy regimes
- minimum liquidity threshold
- maximum spread/slippage threshold
- market-wide risk-off block

Do not implement venue/wallet/custody controls, private keys, live routing, live cancel/replace, token scanner, MEV/gas routing, or compliance/operator permissions.
EOF
      ;;
    6)
      cat <<'EOF'
Goal:
Add safe, disabled-by-default venue/wallet/custody/key-management control records and configuration validation. This must not connect to venues, wallets, or key stores.

Expected output:
- A small module such as scripts/custodyControls.js or scripts/liveCapabilityGuards.js.
- Deterministic capability status showing live trading remains disabled.
- Config/schema validation for future venue, wallet, custody, and key controls without storing secrets.
- Promotion/live-mode blockers that explain which controls are missing or disabled.
- Report/API visibility only if small and scoped.

Do not:
- Add venue adapters.
- Add wallet integrations.
- Add private key handling.
- Add custody providers.
- Submit/cancel/replace live orders.
- Add tiny_live/scaled_live enablement.

Acceptance:
- The system fails closed for all live-capable actions.
- Any future live-capable mode remains blocked with auditable reasons.
- No secrets are read, written, generated, logged, or requested.
EOF
      ;;
    7)
      cat <<'EOF'
Goal:
Add a deterministic token and smart-contract risk scanner representation for research/paper/shadow decisions using available local/E3D metadata where practical.

Expected output:
- A small module such as scripts/tokenRiskScanner.js.
- Stable token_risk_scan_id values.
- Risk scan records linked to token contract_address, signal/order/risk decision where applicable.
- Checks for available metadata: fraud/rug indicators, liquidity quality, stablecoin/base-asset exclusions, missing metadata, holder/contract fields if already available.
- Scanner output included in replay/paper metadata where practical.

Do not:
- Call unapproved paid APIs.
- Add wallet/custody integrations.
- Implement live blocking beyond existing paper/research metadata unless small and explicitly deterministic.
- Implement Phase 8 liquidity routing/MEV/gas controls.
EOF
      ;;
    8)
      cat <<'EOF'
Goal:
Add deterministic liquidity, quote, routing, MEV, and gas-aware execution-control representations for simulated research/paper/shadow execution only.

Expected output:
- A small module such as scripts/liquidityExecutionControls.js.
- Stable quote/execution-control IDs.
- Simulated quote quality, liquidity depth bucket, route feasibility, spread/slippage/gas/MEV warning fields.
- Integration with scripts/executionSimulator.js and backtest reports where practical.
- No real routing or venue submission.

Do not:
- Add live venue adapters.
- Add wallets/private keys.
- Submit/cancel/replace live orders.
- Implement reconciliation/accounting or compliance phases.

Acceptance:
- Simulated fills remain deterministic.
- Replay still does not mutate portfolio.json.
- Every execution-control decision is auditable and linked to order/execution records where practical.
EOF
      ;;
    9)
      cat <<'EOF'
Goal:
Add data quality and market data normalization for research/paper/shadow workflows.

Expected output:
- A small reusable module such as scripts/marketDataQuality.js.
- Deterministic data_quality_id or snapshot hash.
- Normalized fields for price, liquidity, spread/slippage inputs, timestamp/freshness, source, missing fields, and confidence.
- Warnings/blockers for stale, missing, inconsistent, or low-quality market data.
- Integration with replay, execution simulation, and reports where small and safe.

Do not:
- Add new paid data providers unless already configured.
- Implement live venue adapters or live routing.
- Implement later analytics/dashboard phases beyond minimal visibility.

Resume note:
This phase may be resuming after a prior Codex run hit the usage limit before implementing Phase 9. Start by checking whether scripts/marketDataQuality.js or related partial edits already exist, then finish Phase 9 and run verification.
EOF
      ;;
    10)
      cat <<'EOF'
Goal:
Add signal attribution and expectancy analytics using existing candidates, risk decisions, order lifecycle records, simulated fills, performance reports, and trade reviews.

Expected output:
- A module/report such as scripts/signalAttribution.js.
- Stable report IDs and deterministic grouping.
- Attribution by setup, token, category, source agent, reason code, signal snapshot, risk/sizing/execution decision, and strategy version where available.
- Expectancy, sample size, win/loss, fee/slippage drag, and confidence warnings.
- CLI script and package.json check/script updates if appropriate.
- Small API/report integration if clearly scoped.

Do not:
- Retrain models.
- Promote strategies automatically.
- Enable live trading.
- Implement dashboard-heavy Phase 14 work.
EOF
      ;;
    11)
      cat <<'EOF'
Goal:
Add operations, monitoring, alerting, and incident review records for paper/shadow/research operations.

Expected output:
- A small module/report such as scripts/operationsMonitor.js.
- Deterministic operational health summaries from logs/reports.
- Checks for pipeline liveness, stale data, failed checks, portfolio mutation safety, drawdown/risk alerts, missing reports, and promotion blockers.
- Incident records or templates with stable IDs.
- Small server API integration if scoped.

Do not:
- Add external alerting services unless already configured and disabled by default.
- Add operator permissions/compliance controls from Phase 13.
- Enable live trading.
EOF
      ;;
    12)
      cat <<'EOF'
Goal:
Add reconciliation, accounting, and tax-lot export support for paper/replay data only.

Expected output:
- A module/report such as scripts/reconciliationAccounting.js.
- Deterministic reconciliation IDs and export IDs.
- Reconcile action_history, closed_trades, order lifecycle records, simulated fills, and portfolio positions.
- Identify missing order/trade/fill links, cash mismatches, quantity mismatches, realized/unrealized PnL mismatches.
- Export simple CSV/JSON tax-lot style records for paper/replay trades.

Do not:
- Connect to exchanges, wallets, custodians, or tax services.
- Handle private keys.
- Enable live reconciliation or live trading.

Acceptance:
- Backtest/replay remains non-mutating.
- Exports are deterministic for fixed inputs.
EOF
      ;;
    13)
      cat <<'EOF'
Goal:
Add compliance-style audit trail and operator permission records for local paper/shadow/research workflows.

Expected output:
- A module such as scripts/auditTrail.js or scripts/operatorControls.js.
- Stable audit_event_id values.
- Local operator action records for mode changes, pipeline starts/stops, reset requests, report generation, promotion decisions, and risk overrides if any exist.
- Permission policy representation that fails closed for live/tiny_live/scaled_live.
- Small server integration only if scoped and safe.

Do not:
- Add authentication systems beyond local record representation.
- Add external compliance services.
- Enable live trading.
- Implement custody/key-management beyond consuming Phase 6 disabled capability status if present.
EOF
      ;;
    14)
      cat <<'EOF'
Goal:
Add professional dashboard upgrades that surface the professional trading system state without enabling live trading.

Expected output:
- Focused dashboard/API updates for the existing app.
- Show backtest, promotion, execution quality, order lifecycle, risk, data quality, operations, reconciliation, and audit status when available.
- Preserve existing dashboard behavior and style.
- Keep UI dense, operational, and scan-friendly.

Do not:
- Build a marketing landing page.
- Add live trading controls.
- Add wallet/private-key/custody UI.
- Add broad redesigns unrelated to the phase.

Verification:
- Run project checks.
- If starting the dashboard server is needed, use the existing npm dashboard script and report the URL.
EOF
      ;;
    *)
      echo "Unsupported phase: $phase" >&2
      return 1
      ;;
  esac
}

run_phase() {
  local phase="$1"
  local dry_run="$2"
  local model
  model="$(phase_model "$phase")"

  echo "== Phase ${phase}: $(phase_title "$phase") =="
  echo "Model: ${model}"

  if [[ "$dry_run" == "1" ]]; then
    echo "--- prompt ---"
    phase_prompt "$phase"
    echo "--- end prompt ---"
    return 0
  fi

  phase_prompt "$phase" | "$CODEX_BIN" \
    --model "$model" \
    --cd "$ROOT_DIR" \
    --sandbox "$SANDBOX_MODE" \
    --ask-for-approval "$APPROVAL_POLICY" \
    "$MODE" \
    -
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local target="$1"
  shift || true
  local dry_run="0"
  local from_phase="$DEFAULT_START_PHASE"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        dry_run="1"
        shift
        ;;
      --from)
        if [[ $# -lt 2 ]]; then
          echo "--from requires a phase number" >&2
          usage
          exit 1
        fi
        from_phase="$2"
        shift 2
        ;;
      --from=*)
        from_phase="${1#--from=}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ "$target" == "all" ]]; then
    case "$from_phase" in
      5|6|7|8|9|10|11|12|13|14) ;;
      *) echo "Unsupported --from phase: $from_phase" >&2; usage; exit 1 ;;
    esac
    case "$END_PHASE" in
      5|6|7|8|9|10|11|12|13|14) ;;
      *) echo "Unsupported END_PHASE: $END_PHASE" >&2; usage; exit 1 ;;
    esac
    if (( from_phase > END_PHASE )); then
      echo "--from phase must be <= END_PHASE" >&2
      exit 1
    fi
    for (( phase = from_phase; phase <= END_PHASE; phase++ )); do
      run_phase "$phase" "$dry_run"
    done
    return 0
  fi

  case "$target" in
    5|6|7|8|9|10|11|12|13|14) run_phase "$target" "$dry_run" ;;
    *) echo "Unsupported phase: $target" >&2; usage; exit 1 ;;
  esac
}

main "$@"
