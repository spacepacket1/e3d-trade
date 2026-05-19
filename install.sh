#!/usr/bin/env bash
# E3D Agent Trading Floor — Installer
# Usage: bash install.sh [--skip-llm] [--dry-run]
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "\n${BOLD}==> %s${RESET}\n" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "  ${YELLOW}⚠${RESET}  %s\n" "$*" >&2; }
die()  { printf "\n${RED}ERROR:${RESET} %s\n" "$*" >&2; exit 1; }
skip() { printf "  ${YELLOW}–${RESET}  %s (skipped)\n" "$*"; }

DRY=0
SKIP_LLM=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY=1 ;;
    --skip-llm) SKIP_LLM=1 ;;
    --help|-h)
      echo "Usage: bash install.sh [--skip-llm] [--dry-run]"
      echo ""
      echo "  --skip-llm   Skip MLX/Qwen LLM server setup (use if running a remote LLM)"
      echo "  --dry-run    Print what would be done without making changes"
      exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

run() {
  if [[ $DRY -eq 1 ]]; then
    printf "  [dry-run] %s\n" "$*"
  else
    "$@"
  fi
}

# ── Paths ─────────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLX_DIR="${MLX_DIR:-$HOME/clawd/e3d}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node 2>/dev/null || true)"
PYTHON_BIN="$(command -v python3 2>/dev/null || true)"

LABEL_PIPELINE="com.e3d.pipeline"
LABEL_LLM_14B="com.e3d.llm.gunicorn"
LABEL_LLM_7B="com.e3d.llm.gunicorn7b"

PLIST_PIPELINE="$LAUNCH_AGENTS_DIR/$LABEL_PIPELINE.plist"
PLIST_LLM_14B="$LAUNCH_AGENTS_DIR/$LABEL_LLM_14B.plist"
PLIST_LLM_7B="$LAUNCH_AGENTS_DIR/$LABEL_LLM_7B.plist"

TRAINING_CRON_SCRIPT="$MLX_DIR/cron_train_agents.sh"
TRAINING_CRON_LOG="$MLX_DIR/logs/cron_train.log"
TRAINING_CRON_LINE="0 3 * * 0 $TRAINING_CRON_SCRIPT >> $TRAINING_CRON_LOG 2>&1"

# ── 1. OS check ───────────────────────────────────────────────────────────────
log "Checking platform"
if [[ "$(uname)" != "Darwin" ]]; then
  die "This installer requires macOS (launchd). On Linux, configure systemd manually."
fi
ok "macOS detected"

if [[ "$(uname -m)" != "arm64" ]] && [[ $SKIP_LLM -eq 0 ]]; then
  warn "MLX requires Apple Silicon. On Intel Macs, use --skip-llm and point LLM_BASE_URL at a remote server."
fi

# ── 2. Prerequisites ──────────────────────────────────────────────────────────
log "Checking prerequisites"

require_cmd() {
  local cmd="$1" msg="${2:-$1}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Missing required tool: $msg"
  fi
}

require_cmd node  "Node.js (https://nodejs.org)"
require_cmd npm   "npm (bundled with Node.js)"
require_cmd docker "Docker (https://docs.docker.com/get-docker/)"
require_cmd launchctl "launchctl (should be present on macOS)"

NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node.js 18+ required (found v$NODE_VERSION)"
fi
ok "Node.js v$NODE_VERSION"

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  die "Docker Compose is required (docker compose or docker-compose)"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
else
  COMPOSE_CMD=(docker-compose)
fi
ok "Docker Compose (${COMPOSE_CMD[*]})"

if [[ $SKIP_LLM -eq 0 ]]; then
  if [[ -z "$PYTHON_BIN" ]]; then
    warn "python3 not found — skipping LLM server setup. Pass --skip-llm to suppress this warning."
    SKIP_LLM=1
  else
    PY_VERSION=$("$PYTHON_BIN" --version 2>&1 | awk '{print $2}')
    PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
    if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 11 ]]; }; then
      warn "Python 3.11+ recommended for MLX (found $PY_VERSION). Continuing anyway."
    fi
    ok "Python $PY_VERSION"
  fi
fi

# ── 3. JavaScript dependencies ────────────────────────────────────────────────
log "Installing JavaScript dependencies"
run npm --prefix "$REPO_DIR" install
ok "npm install complete"

log "Validating pipeline syntax"
run npm --prefix "$REPO_DIR" run check
ok "Syntax check passed"

# ── 4. Python / MLX LLM server ───────────────────────────────────────────────
install_llm_server() {
  log "Setting up MLX/Qwen LLM server"

  if [[ ! -d "$MLX_DIR" ]]; then
    warn "MLX directory not found: $MLX_DIR"
    warn "Create it and place mlx_server.py there, or override MLX_DIR env var."
    warn "Skipping LLM server setup."
    return
  fi
  ok "MLX directory: $MLX_DIR"

  # Python venv
  local venv="$MLX_DIR/.venv"
  if [[ ! -d "$venv" ]]; then
    log "Creating Python venv at $venv"
    run "$PYTHON_BIN" -m venv "$venv"
  fi
  ok "Python venv: $venv"

  # Install Python packages
  log "Installing MLX Python packages"
  run "$venv/bin/pip" install --quiet --upgrade mlx-lm flask gunicorn
  ok "mlx-lm, flask, gunicorn installed"

  # Generate start_gunicorn.sh if missing
  local sg14="$MLX_DIR/start_gunicorn.sh"
  if [[ ! -f "$sg14" ]]; then
    log "Generating $sg14"
    if [[ $DRY -eq 0 ]]; then
      cat > "$sg14" <<SCRIPT
#!/bin/bash
set -euo pipefail
cd "$MLX_DIR"
source .venv/bin/activate
export LLM_ADAPTER_PATH=\${LLM_ADAPTER_PATH:-./adapters_scout_v1}
export LLM_MAX_PROMPT_CHARS=200000
export LLM_MAX_TOKENS=6000
exec gunicorn mlx_server:app \\
  --workers 1 --threads 1 --worker-class sync \\
  --bind 0.0.0.0:5050 \\
  --timeout 1000 --graceful-timeout 1000 \\
  --log-level info --capture-output
SCRIPT
      chmod +x "$sg14"
    fi
    ok "Created $sg14"
  else
    ok "start_gunicorn.sh exists"
  fi

  # Generate start_gunicorn_7b.sh if missing
  local sg7b="$MLX_DIR/start_gunicorn_7b.sh"
  if [[ ! -f "$sg7b" ]]; then
    log "Generating $sg7b"
    if [[ $DRY -eq 0 ]]; then
      cat > "$sg7b" <<SCRIPT
#!/bin/bash
set -euo pipefail
cd "$MLX_DIR"
source .venv/bin/activate
export LLM_MODEL="mlx-community/Qwen2.5-7B-Instruct-4bit"
export LLM_ADAPTER_PATH=""
export LLM_MAX_TOKENS=1024
export LLM_MAX_PROMPT_CHARS=200000
exec gunicorn mlx_server:app \\
  --workers 1 --threads 1 --worker-class sync \\
  --bind 0.0.0.0:5051 \\
  --timeout 1000 --graceful-timeout 1000 \\
  --log-level info --capture-output
SCRIPT
      chmod +x "$sg7b"
    fi
    ok "Created $sg7b"
  else
    ok "start_gunicorn_7b.sh exists"
  fi

  # LLM logs dir
  run mkdir -p "$MLX_DIR/logs"

  # LaunchAgent: 14B model (port 5050)
  log "Installing LaunchAgent: $LABEL_LLM_14B (port 5050)"
  if launchctl list | grep -q "$LABEL_LLM_14B" 2>/dev/null; then
    run launchctl unload "$PLIST_LLM_14B" 2>/dev/null || true
  fi
  if [[ $DRY -eq 0 ]]; then
    cat > "$PLIST_LLM_14B" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_LLM_14B</string>
  <key>ProgramArguments</key>
  <array><string>$MLX_DIR/start_gunicorn.sh</string></array>
  <key>WorkingDirectory</key><string>$MLX_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$MLX_DIR/llm_server.out.log</string>
  <key>StandardErrorPath</key><string>$MLX_DIR/llm_server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PYTHONUNBUFFERED</key><string>1</string></dict>
</dict>
</plist>
PLIST
  fi
  run launchctl load "$PLIST_LLM_14B"
  ok "LaunchAgent $LABEL_LLM_14B loaded"

  # LaunchAgent: 7B model (port 5051)
  log "Installing LaunchAgent: $LABEL_LLM_7B (port 5051)"
  if launchctl list | grep -q "$LABEL_LLM_7B" 2>/dev/null; then
    run launchctl unload "$PLIST_LLM_7B" 2>/dev/null || true
  fi
  if [[ $DRY -eq 0 ]]; then
    cat > "$PLIST_LLM_7B" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_LLM_7B</string>
  <key>ProgramArguments</key>
  <array><string>$MLX_DIR/start_gunicorn_7b.sh</string></array>
  <key>WorkingDirectory</key><string>$MLX_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$MLX_DIR/llm_server_7b.out.log</string>
  <key>StandardErrorPath</key><string>$MLX_DIR/llm_server_7b.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PYTHONUNBUFFERED</key><string>1</string></dict>
</dict>
</plist>
PLIST
  fi
  run launchctl load "$PLIST_LLM_7B"
  ok "LaunchAgent $LABEL_LLM_7B loaded"
}

if [[ $SKIP_LLM -eq 1 ]]; then
  skip "MLX/Qwen LLM server (--skip-llm)"
else
  install_llm_server
fi

# ── 5. Docker (Mongo + ClickHouse) ────────────────────────────────────────────
log "Starting local databases (Mongo + ClickHouse)"
run "${COMPOSE_CMD[@]}" --project-directory "$REPO_DIR" up -d mongo clickhouse

# Wait up to 30s for healthy status
if [[ $DRY -eq 0 ]]; then
  echo "  Waiting for containers to become healthy..."
  for i in $(seq 1 30); do
    mongo_ok=$(docker inspect --format='{{.State.Health.Status}}' e3d-mongo 2>/dev/null || echo "missing")
    ch_ok=$(docker inspect --format='{{.State.Health.Status}}' e3d-clickhouse 2>/dev/null || echo "missing")
    if [[ "$mongo_ok" == "healthy" && "$ch_ok" == "healthy" ]]; then
      break
    fi
    sleep 1
  done
  mongo_ok=$(docker inspect --format='{{.State.Health.Status}}' e3d-mongo 2>/dev/null || echo "unknown")
  ch_ok=$(docker inspect --format='{{.State.Health.Status}}' e3d-clickhouse 2>/dev/null || echo "unknown")
  [[ "$mongo_ok" == "healthy" ]] && ok "MongoDB healthy" || warn "MongoDB status: $mongo_ok"
  [[ "$ch_ok"    == "healthy" ]] && ok "ClickHouse healthy" || warn "ClickHouse status: $ch_ok"
fi

# ── 6. LaunchAgent: Dashboard + pipeline manager ──────────────────────────────
log "Installing LaunchAgent: $LABEL_PIPELINE (port 3000)"
if launchctl list | grep -q "$LABEL_PIPELINE" 2>/dev/null; then
  run launchctl unload "$PLIST_PIPELINE" 2>/dev/null || true
fi
if [[ $DRY -eq 0 ]]; then
  cat > "$PLIST_PIPELINE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_PIPELINE</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$REPO_DIR/logs/server-stdout.log</string>
  <key>StandardErrorPath</key><string>$REPO_DIR/logs/server-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
</dict>
</plist>
PLIST
fi
run launchctl load "$PLIST_PIPELINE"
ok "LaunchAgent $LABEL_PIPELINE loaded"

# ── 7. Training cron job ──────────────────────────────────────────────────────
log "Installing weekly agent training cron job"
if [[ ! -f "$TRAINING_CRON_SCRIPT" ]]; then
  warn "Training script not found at $TRAINING_CRON_SCRIPT — skipping cron install."
  warn "Copy training/cron_train_agents.sh to $MLX_DIR/ and re-run to enable training."
elif crontab -l 2>/dev/null | grep -qF "$TRAINING_CRON_SCRIPT"; then
  ok "Training cron job already installed"
else
  run mkdir -p "$MLX_DIR/logs"
  if [[ $DRY -eq 0 ]]; then
    (crontab -l 2>/dev/null; echo "$TRAINING_CRON_LINE") | crontab -
  fi
  ok "Training cron job installed (Sundays at 3 AM)"
fi

# ── 8. App directory ──────────────────────────────────────────────────────────
run mkdir -p "$HOME/.e3d-agent-trading-floor"
run mkdir -p "$REPO_DIR/logs"

# ── 9. Verify ─────────────────────────────────────────────────────────────────
log "Verifying services"
if [[ $DRY -eq 0 ]]; then
  sleep 4  # give launchd a moment to start things

  # LLM server
  if [[ $SKIP_LLM -eq 0 ]]; then
    llm_status=$(curl -sf http://127.0.0.1:5050/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "unreachable")
    if [[ "$llm_status" == "ok" ]]; then
      ok "LLM server (5050): ok"
    else
      warn "LLM server (5050): $llm_status — model may still be loading (check $MLX_DIR/llm_server.out.log)"
    fi
  fi

  # Dashboard
  dash_ok=$(curl -sf http://127.0.0.1:3000/api/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',d.get('ok','?')))" 2>/dev/null || echo "unreachable")
  if [[ "$dash_ok" != "unreachable" ]]; then
    ok "Dashboard (3000): up"
  else
    warn "Dashboard (3000): not yet responding — check $REPO_DIR/logs/server-stdout.log"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}Installation complete.${RESET}\n\n"
printf "  Dashboard:   http://localhost:3000\n"
if [[ $SKIP_LLM -eq 0 ]]; then
  printf "  LLM health:  http://localhost:5050/health\n"
fi
printf "  Pipeline:    Start from the dashboard or POST to http://localhost:3000/api/pipeline/start\n"
printf "\n"
printf "  Logs:\n"
printf "    Server:    $REPO_DIR/logs/server-stdout.log\n"
[[ $SKIP_LLM -eq 0 ]] && printf "    LLM:       $MLX_DIR/llm_server.out.log\n"
printf "\n"
printf "  To log in to E3D:  open http://localhost:3000 and click Sign In\n"
printf "  To uninstall:      bash $REPO_DIR/uninstall.sh\n"
printf "\n"
