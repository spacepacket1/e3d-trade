#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/removeJevCycleCadenceCron.sh [--dry-run]

Removes the shadow Jev cadence gate cron entry if present.
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "removeJevCycleCadenceCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${JEV_CADENCE_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRONTAB_BIN="${JEV_CADENCE_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
CRON_SCRIPT="$REPO_DIR/scripts/jevCycleCadenceGate.js"

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "removeJevCycleCadenceCron: crontab is required" >&2
  exit 1
fi

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if ! printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$CRON_SCRIPT"; then
  echo "removeJevCycleCadenceCron: not installed"
  exit 0
fi

FILTERED_CRONTAB="$(printf "%s\n" "$CURRENT_CRONTAB" | grep -vF "$CRON_SCRIPT" || true)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "removeJevCycleCadenceCron: would remove"
  exit 0
fi

printf "%s\n" "$FILTERED_CRONTAB" | "$CRONTAB_BIN" -
echo "removeJevCycleCadenceCron: removed"
