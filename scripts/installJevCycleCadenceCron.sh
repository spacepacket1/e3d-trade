#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/installJevCycleCadenceCron.sh [--dry-run] [--print]

Installs a cron entry to run the shadow Jev cadence gate every 15 minutes.
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
      echo "installJevCycleCadenceCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${JEV_CADENCE_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${JEV_CADENCE_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
CRONTAB_BIN="${JEV_CADENCE_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
CRON_SCRIPT="$REPO_DIR/scripts/jevCycleCadenceGate.js"
CRON_LOG="${JEV_CADENCE_CRON_LOG:-$REPO_DIR/logs/jev-cycle-cadence-gate.log}"
CRON_SCHEDULE="${JEV_CADENCE_CRON_SCHEDULE:-*/15 * * * *}"
CRON_LINE="$CRON_SCHEDULE cd \"$REPO_DIR\" && \"$NODE_BIN\" \"$REPO_DIR/scripts/jevCycleCadenceGate.js\" >> \"$CRON_LOG\" 2>&1"

if [[ -z "$NODE_BIN" ]]; then
  echo "installJevCycleCadenceCron: node is required" >&2
  exit 1
fi

if [[ ! -f "$CRON_SCRIPT" ]]; then
  echo "installJevCycleCadenceCron: cadence script not found at $CRON_SCRIPT" >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "installJevCycleCadenceCron: crontab is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$CRON_LOG")"

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "jevCycleCadenceGate.js"; then
  echo "installJevCycleCadenceCron: already installed"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "installJevCycleCadenceCron: would install"
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

{
  printf "%s\n" "$CURRENT_CRONTAB"
  printf "%s\n" "$CRON_LINE"
} | "$CRONTAB_BIN" -

echo "installJevCycleCadenceCron: installed"
printf "%s\n" "$CRON_LINE"
