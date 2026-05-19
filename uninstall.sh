#!/usr/bin/env bash
# E3D Agent Trading Floor — Uninstaller
#
# Usage: bash uninstall.sh [options]
#
# Options:
#   --purge-data    Also remove Docker volumes (destroys all trade history, portfolio, ClickHouse data)
#   --purge-models  Also remove MLX model weights from Hugging Face cache (~8 GB)
#   --purge-all     Implies --purge-data + --purge-models, removes node_modules and Python venv
#   --dry-run       Print what would be done without making changes
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "\n${BOLD}==> %s${RESET}\n" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "  ${YELLOW}⚠${RESET}  %s\n" "$*" >&2; }
skip() { printf "  –  %s\n" "$*"; }

DRY=0; PURGE_DATA=0; PURGE_MODELS=0; PURGE_ALL=0
for arg in "$@"; do
  case "$arg" in
    --purge-data)   PURGE_DATA=1 ;;
    --purge-models) PURGE_MODELS=1 ;;
    --purge-all)    PURGE_ALL=1; PURGE_DATA=1; PURGE_MODELS=1 ;;
    --dry-run)      DRY=1 ;;
    --help|-h)
      echo "Usage: bash uninstall.sh [--purge-data] [--purge-models] [--purge-all] [--dry-run]"
      echo ""
      echo "  --purge-data    Remove Docker volumes (trade history, portfolio, ClickHouse data)"
      echo "  --purge-models  Remove downloaded MLX model weights from Hugging Face cache (~8 GB)"
      echo "  --purge-all     All of the above, plus node_modules and Python venv"
      echo "  --dry-run       Show what would happen without doing it"
      exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

run() {
  if [[ $DRY -eq 1 ]]; then
    printf "  [dry-run] %s\n" "$*"
  else
    "$@"
  fi
}

# Guard against accidental --purge-data without explicit confirmation
if [[ $PURGE_DATA -eq 1 && $DRY -eq 0 ]]; then
  printf "${RED}${BOLD}WARNING:${RESET} --purge-data will permanently delete all trade history,\n"
  printf "portfolio state, and ClickHouse training data. This cannot be undone.\n\n"
  read -rp "Type YES to confirm: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLX_DIR="${MLX_DIR:-$HOME/clawd/e3d}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

LABEL_PIPELINE="com.e3d.pipeline"
LABEL_LLM_14B="com.e3d.llm.gunicorn"
LABEL_LLM_7B="com.e3d.llm.gunicorn7b"

PLIST_PIPELINE="$LAUNCH_AGENTS_DIR/$LABEL_PIPELINE.plist"
PLIST_LLM_14B="$LAUNCH_AGENTS_DIR/$LABEL_LLM_14B.plist"
PLIST_LLM_7B="$LAUNCH_AGENTS_DIR/$LABEL_LLM_7B.plist"

TRAINING_CRON_SCRIPT="$MLX_DIR/cron_train_agents.sh"

# ── 1. Stop and remove LaunchAgents ──────────────────────────────────────────
log "Stopping and removing LaunchAgents"

unload_agent() {
  local label="$1" plist="$2"
  if launchctl list 2>/dev/null | grep -q "$label"; then
    run launchctl unload "$plist" 2>/dev/null || true
    ok "Unloaded $label"
  else
    skip "$label (not loaded)"
  fi
  if [[ -f "$plist" ]]; then
    run rm -f "$plist"
    ok "Removed $plist"
  else
    skip "$plist (not found)"
  fi
}

unload_agent "$LABEL_PIPELINE" "$PLIST_PIPELINE"
unload_agent "$LABEL_LLM_14B"  "$PLIST_LLM_14B"
unload_agent "$LABEL_LLM_7B"   "$PLIST_LLM_7B"

# Kill any orphaned pipeline.js or server.js spawned outside launchd
for proc in "server.js" "pipeline.js"; do
  pids=$(pgrep -f "node.*$proc" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    run kill $pids 2>/dev/null || true
    ok "Stopped orphaned $proc (pids: $pids)"
  fi
done

# ── 2. Remove training cron job ───────────────────────────────────────────────
log "Removing training cron job"
if crontab -l 2>/dev/null | grep -qF "$TRAINING_CRON_SCRIPT"; then
  if [[ $DRY -eq 0 ]]; then
    crontab -l 2>/dev/null | grep -vF "$TRAINING_CRON_SCRIPT" | crontab -
  fi
  ok "Removed training cron entry"
else
  skip "Training cron entry (not found)"
fi

# ── 3. Stop Docker containers ─────────────────────────────────────────────────
log "Stopping Docker containers"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    COMPOSE_CMD=()
  fi

  if [[ ${#COMPOSE_CMD[@]} -gt 0 ]]; then
    if [[ $PURGE_DATA -eq 1 ]]; then
      run "${COMPOSE_CMD[@]}" --project-directory "$REPO_DIR" down -v
      ok "Containers stopped and volumes removed"
    else
      run "${COMPOSE_CMD[@]}" --project-directory "$REPO_DIR" down
      ok "Containers stopped (volumes preserved)"
    fi
  else
    warn "Docker Compose not available — stop containers manually"
  fi
else
  skip "Docker not running — containers may still be running"
fi

# ── 4. Purge: node_modules and Python venv ───────────────────────────────────
if [[ $PURGE_ALL -eq 1 ]]; then
  log "Removing node_modules"
  if [[ -d "$REPO_DIR/node_modules" ]]; then
    run rm -rf "$REPO_DIR/node_modules"
    ok "Removed node_modules"
  else
    skip "node_modules (not found)"
  fi

  log "Removing Python venv"
  if [[ -d "$MLX_DIR/.venv" ]]; then
    run rm -rf "$MLX_DIR/.venv"
    ok "Removed $MLX_DIR/.venv"
  else
    skip "Python venv (not found)"
  fi
fi

# ── 5. Purge: MLX model weights ───────────────────────────────────────────────
if [[ $PURGE_MODELS -eq 1 ]]; then
  log "Removing MLX model weights"
  HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"
  for model_dir in \
    "$HF_CACHE/models--mlx-community--Qwen2.5-14B-Instruct-4bit" \
    "$HF_CACHE/models--mlx-community--Qwen2.5-7B-Instruct-4bit"
  do
    if [[ -d "$model_dir" ]]; then
      size=$(du -sh "$model_dir" 2>/dev/null | cut -f1 || echo "?")
      run rm -rf "$model_dir"
      ok "Removed model cache ($size): $model_dir"
    else
      skip "$(basename "$model_dir") (not found in HF cache)"
    fi
  done
fi

# ── 6. Remove app directory ───────────────────────────────────────────────────
log "Removing app configuration directory"
APP_DIR="$HOME/.e3d-agent-trading-floor"
if [[ -d "$APP_DIR" ]]; then
  run rm -rf "$APP_DIR"
  ok "Removed $APP_DIR (auth tokens cleared)"
else
  skip "$APP_DIR (not found)"
fi

# ── 7. Clear macOS Keychain entry ─────────────────────────────────────────────
log "Removing Keychain entry"
if security find-generic-password -s "e3d-agent-trading-floor" -a "e3d-ai" >/dev/null 2>&1; then
  run security delete-generic-password -s "e3d-agent-trading-floor" -a "e3d-ai"
  ok "Removed Keychain entry"
else
  skip "Keychain entry (not found)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}Uninstall complete.${RESET}\n\n"

if [[ $PURGE_DATA -eq 0 ]]; then
  printf "  Trade history and portfolio data preserved in Docker volumes.\n"
  printf "  To also remove: bash uninstall.sh --purge-data\n\n"
fi
if [[ $PURGE_MODELS -eq 0 ]]; then
  printf "  MLX model weights (~8 GB) are still in the Hugging Face cache.\n"
  printf "  To also remove: bash uninstall.sh --purge-models\n\n"
fi
if [[ $PURGE_ALL -eq 0 ]]; then
  printf "  Source code and LoRA adapters are untouched.\n\n"
fi
printf "  To reinstall: bash $REPO_DIR/install.sh\n\n"
