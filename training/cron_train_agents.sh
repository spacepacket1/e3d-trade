#!/bin/bash
set -uo pipefail
# Note: no -e so that individual training failures don't abort the full run.
# Exit codes are captured per-script and summarized at the end.

# ─── Setup ───────────────────────────────────────────────────────────────────

E3D_DIR="/Users/mini/clawd/e3d"
TRAIN_DIR="/Users/mini/e3d-agent-trading-floor/training"

# Re-exec under nohup so session disconnects cannot kill the training run.
# The guard prevents infinite re-exec; exec replaces this process in-place.
if [[ -z "${_TRAINING_NOHUP:-}" ]]; then
  export _TRAINING_NOHUP=1
  exec nohup "$0" "$@" >> "${E3D_DIR}/logs/cron_train.log" 2>&1 </dev/null
fi

STATUS_FILE="${E3D_DIR}/last_training_status.json"
START_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log "========================================"
log "=== E3D Agent Training Pipeline Run  ==="
log "========================================"
log "Start time: ${START_TS}"
log "Host: $(hostname)"

# ─── Step 1: Disk space check ────────────────────────────────────────────────

log "Checking available disk space..."
# df -g on macOS: output in 1GB blocks; field 4 is Available
AVAIL_GB=$(df -g "${E3D_DIR}" | awk 'NR==2 {print $4}')

if [[ -z "${AVAIL_GB}" ]]; then
  log "ERROR: Could not determine disk space for ${E3D_DIR}."
  exit 1
fi

log "Available disk space: ${AVAIL_GB} GB"

if [[ "${AVAIL_GB}" -lt 10 ]]; then
  log "ERROR: Insufficient disk space. Need at least 10 GB free, only ${AVAIL_GB} GB available."
  log "Training aborted."
  exit 1
fi

log "Disk space OK (${AVAIL_GB} GB free)."

# ─── Step 2: MLX server health check ─────────────────────────────────────────

log "Checking MLX server health at http://localhost:5050/health..."
if curl -sf http://localhost:5050/health > /dev/null 2>&1; then
  log "MLX server is UP."
else
  log "WARNING: MLX server did not respond. Training does not require the server — continuing."
fi

# ─── Step 3: Train scout adapter ─────────────────────────────────────────────

log "----------------------------------------"
log "Running Scout adapter training..."
log "----------------------------------------"
"${TRAIN_DIR}/train_scout_adapter.sh"
SCOUT_EXIT=$?

if [[ "${SCOUT_EXIT}" -eq 0 ]]; then
  log "Scout training: OK (exit ${SCOUT_EXIT})"
  SCOUT_OK="true"
else
  log "Scout training: FAILED (exit ${SCOUT_EXIT})"
  SCOUT_OK="false"
fi

# ─── Step 4: Train harvest adapter ───────────────────────────────────────────

log "----------------------------------------"
log "Running Harvest adapter training..."
log "----------------------------------------"
"${TRAIN_DIR}/train_harvest_adapter.sh"
HARVEST_EXIT=$?

if [[ "${HARVEST_EXIT}" -eq 0 ]]; then
  log "Harvest training: OK (exit ${HARVEST_EXIT})"
  HARVEST_OK="true"
else
  log "Harvest training: FAILED (exit ${HARVEST_EXIT})"
  HARVEST_OK="false"
fi

# ─── Step 5: Write status file ────────────────────────────────────────────────

END_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
python3 -c "
import json
print(json.dumps({
  'ts': '${END_TS}',
  'scout_ok': '${SCOUT_OK}' == 'true',
  'harvest_ok': '${HARVEST_OK}' == 'true'
}, indent=2))
" > "${STATUS_FILE}"
log "Status written to ${STATUS_FILE}."

# ─── Step 6: Final summary ────────────────────────────────────────────────────

log "========================================"
log "=== Training Pipeline Summary        ==="
log "========================================"
log "Scout:   ${SCOUT_OK}"
log "Harvest: ${HARVEST_OK}"
log "Finished at: ${END_TS}"
log "Status file: ${STATUS_FILE}"
log "========================================"

# Exit non-zero if either run failed
if [[ "${SCOUT_OK}" == "false" || "${HARVEST_OK}" == "false" ]]; then
  exit 1
fi

exit 0
