#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/installPortfolioSnapshotCron.sh [--dry-run] [--print]

Installs a cron entry to write one AgentPortfolioSnapshots row every 5 minutes.
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
      echo "installPortfolioSnapshotCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${PORTFOLIO_SNAPSHOT_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${PORTFOLIO_SNAPSHOT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
CRONTAB_BIN="${PORTFOLIO_SNAPSHOT_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
SNAPSHOT_SCRIPT="$REPO_DIR/scripts/portfolioSnapshotWriter.js"
CRON_LOG="${PORTFOLIO_SNAPSHOT_CRON_LOG:-$REPO_DIR/logs/portfolio-snapshot-writer.log}"
CRON_SCHEDULE="${PORTFOLIO_SNAPSHOT_CRON_SCHEDULE:-*/5 * * * *}"
CRON_LINE="$CRON_SCHEDULE cd $REPO_DIR && $NODE_BIN $SNAPSHOT_SCRIPT >> $CRON_LOG 2>&1"

if [[ -z "$NODE_BIN" ]]; then
  echo "installPortfolioSnapshotCron: node is required" >&2
  exit 1
fi

if [[ ! -f "$SNAPSHOT_SCRIPT" ]]; then
  echo "installPortfolioSnapshotCron: snapshot script not found at $SNAPSHOT_SCRIPT" >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "installPortfolioSnapshotCron: crontab is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$CRON_LOG")"

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$SNAPSHOT_SCRIPT"; then
  echo "installPortfolioSnapshotCron: already installed"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "installPortfolioSnapshotCron: would install"
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

{
  printf "%s\n" "$CURRENT_CRONTAB"
  printf "%s\n" "$CRON_LINE"
} | "$CRONTAB_BIN" -

echo "installPortfolioSnapshotCron: installed"
printf "%s\n" "$CRON_LINE"
