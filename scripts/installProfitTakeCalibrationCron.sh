#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/installProfitTakeCalibrationCron.sh [--dry-run] [--print]

Installs a cron entry to run scripts/profitTakeCalibration.js hourly.
EOF
}

DRY_RUN=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --print) PRINT_ONLY=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "installProfitTakeCalibrationCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${PROFIT_TAKE_CALIBRATION_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${PROFIT_TAKE_CALIBRATION_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
CRONTAB_BIN="${PROFIT_TAKE_CALIBRATION_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
TARGET_SCRIPT="$REPO_DIR/scripts/profitTakeCalibration.js"
CRON_LOG="${PROFIT_TAKE_CALIBRATION_CRON_LOG:-$REPO_DIR/logs/profit-take-calibration.log}"
CRON_SCHEDULE="${PROFIT_TAKE_CALIBRATION_CRON_SCHEDULE:-0 * * * *}"
CRON_LINE="$CRON_SCHEDULE cd \"$REPO_DIR\" && \"$NODE_BIN\" \"$TARGET_SCRIPT\" >> \"$CRON_LOG\" 2>&1"

if [[ -z "$NODE_BIN" ]]; then
  echo "installProfitTakeCalibrationCron: node is required" >&2
  exit 1
fi

if [[ ! -f "$TARGET_SCRIPT" ]]; then
  echo "installProfitTakeCalibrationCron: target script not found at $TARGET_SCRIPT" >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "installProfitTakeCalibrationCron: crontab is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$CRON_LOG")"

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$TARGET_SCRIPT"; then
  echo "installProfitTakeCalibrationCron: already installed"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "installProfitTakeCalibrationCron: would install"
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

{
  printf "%s\n" "$CURRENT_CRONTAB"
  printf "%s\n" "$CRON_LINE"
} | "$CRONTAB_BIN" -

echo "installProfitTakeCalibrationCron: installed"
printf "%s\n" "$CRON_LINE"
