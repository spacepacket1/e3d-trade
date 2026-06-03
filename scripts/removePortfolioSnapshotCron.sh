#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/removePortfolioSnapshotCron.sh [--dry-run]

Removes the AgentPortfolioSnapshots cron entry if present.
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
      echo "removePortfolioSnapshotCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${PORTFOLIO_SNAPSHOT_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRONTAB_BIN="${PORTFOLIO_SNAPSHOT_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
SNAPSHOT_SCRIPT="$REPO_DIR/scripts/portfolioSnapshotWriter.js"

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "removePortfolioSnapshotCron: crontab is required" >&2
  exit 1
fi

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if ! printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$SNAPSHOT_SCRIPT"; then
  echo "removePortfolioSnapshotCron: not installed"
  exit 0
fi

FILTERED_CRONTAB="$(printf "%s\n" "$CURRENT_CRONTAB" | grep -vF "$SNAPSHOT_SCRIPT" || true)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "removePortfolioSnapshotCron: would remove"
  exit 0
fi

printf "%s\n" "$FILTERED_CRONTAB" | "$CRONTAB_BIN" -
echo "removePortfolioSnapshotCron: removed"
