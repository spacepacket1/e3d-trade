#!/bin/bash
set -euo pipefail

# ─── Setup ───────────────────────────────────────────────────────────────────

E3D_DIR="/Users/mini/clawd/e3d"
TRAIN_DIR="/Users/mini/e3d-agent-trading-floor/training"

cd "${E3D_DIR}"
source .venv/bin/activate

AGENT="scout"
CONFIG="${TRAIN_DIR}/train_config_scout_v1.yaml"
ADAPTER_DIR="adapters_scout_v1"
DATA_DIR="data/scout"
RUNS_LOG="training_runs.jsonl"
START_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_EPOCH=$(date +%s)

log() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log "=== Scout Adapter Training ==="
log "Working dir: $(pwd)"
log "Start time: ${START_TS}"

# ─── Step 1: Extract training data ───────────────────────────────────────────

log "Running training data extraction for agent: ${AGENT}..."
python3 "${TRAIN_DIR}/extract_agent_training_data.py" --agent scout --output data --synthetic-count 300

# ─── Step 2: Validate data files ─────────────────────────────────────────────

log "Checking training data..."
if [[ ! -f "${DATA_DIR}/train.jsonl" ]]; then
  log "WARNING: ${DATA_DIR}/train.jsonl not found. Continuing on synthetic-only data."
  exit 0
fi

TRAIN_LINES=$(wc -l < "${DATA_DIR}/train.jsonl" | tr -d ' ')
if [[ "${TRAIN_LINES}" -lt 10 ]]; then
  log "WARNING: ${DATA_DIR}/train.jsonl has only ${TRAIN_LINES} lines (need at least 10). Continuing on synthetic-only data."
  exit 0
fi

# Count examples
VALID_LINES=0
TEST_LINES=0
[[ -f "${DATA_DIR}/valid.jsonl" ]] && VALID_LINES=$(wc -l < "${DATA_DIR}/valid.jsonl" | tr -d ' ')
[[ -f "${DATA_DIR}/test.jsonl" ]]  && TEST_LINES=$(wc -l  < "${DATA_DIR}/test.jsonl"  | tr -d ' ')

log "Examples — train: ${TRAIN_LINES}, valid: ${VALID_LINES}, test: ${TEST_LINES}"

# ─── Step 3: Back up existing adapter ────────────────────────────────────────

BACKUP_DIR=""
if [[ -d "${ADAPTER_DIR}" ]]; then
  BACKUP_DIR="${ADAPTER_DIR}_backup_$(date +%Y%m%d_%H%M%S)"
  log "Backing up existing adapter to ${BACKUP_DIR}..."
  cp -r "${ADAPTER_DIR}/" "${BACKUP_DIR}/"
  log "Backup complete."
  log "Clearing adapter dir for cold retrain..."
  rm -rf "${ADAPTER_DIR}"
fi

# ─── Step 4: Train ───────────────────────────────────────────────────────────

log "Starting LoRA training with config: ${CONFIG}..."
mlx_lm.lora --config "${CONFIG}"
log "Training finished."

# ─── Step 5: Evaluate ────────────────────────────────────────────────────────

log "Running evaluation on test set..."
EVAL_OUTPUT=$(mlx_lm.lora --config "${CONFIG}" --test 2>&1)
log "Eval output:"
printf "%s\n" "${EVAL_OUTPUT}"

# Parse "Test loss: 1.2345" from output (handles variations in spacing/case)
NEW_LOSS=$(printf "%s" "${EVAL_OUTPUT}" | grep -i "test loss" | grep -oE "[0-9]+\.[0-9]+" | head -1 || true)
if [[ -z "${NEW_LOSS}" ]]; then
  log "WARNING: Could not parse eval loss from output. Skipping regression check."
  NEW_LOSS="null"
fi
log "Eval loss: ${NEW_LOSS}"

# ─── Step 6: Regression check ────────────────────────────────────────────────

STATUS="ok"
PREV_LOSS=""

if [[ "${NEW_LOSS}" != "null" && -f "${RUNS_LOG}" ]]; then
  # Find last scout entry with status=ok, extract eval_loss
  PREV_LOSS=$(grep '"agent": *"scout"' "${RUNS_LOG}" | grep '"status": *"ok"' | \
    python3 -c "
import sys, json
entries = [json.loads(l) for l in sys.stdin if l.strip()]
ok = [e for e in entries if e.get('agent') == 'scout' and e.get('status') == 'ok']
if ok:
    print(ok[-1].get('eval_loss', ''))
" 2>/dev/null || true)
fi

if [[ -n "${PREV_LOSS}" && "${NEW_LOSS}" != "null" ]]; then
  # Compare: regress if new_loss > prev_loss * 1.05
  REGRESSED=$(python3 -c "
new=${NEW_LOSS}; prev=${PREV_LOSS}
print('yes' if new > prev * 1.05 else 'no')
" 2>/dev/null || echo "no")

  if [[ "${REGRESSED}" == "yes" ]]; then
    log "Regression detected: new loss ${NEW_LOSS} > prev loss ${PREV_LOSS} by more than 5%."
    if [[ -n "${BACKUP_DIR}" && -d "${BACKUP_DIR}" ]]; then
      log "Restoring backup adapter from ${BACKUP_DIR}..."
      rm -rf "${ADAPTER_DIR}"
      cp -r "${BACKUP_DIR}/" "${ADAPTER_DIR}/"
      log "Rollback complete."
    else
      log "No backup available to restore."
    fi
    STATUS="rolled_back"
  fi
fi

# ─── Step 7: Write training run metadata ─────────────────────────────────────

END_EPOCH=$(date +%s)
DURATION=$(( END_EPOCH - START_EPOCH ))
ADAPTER_VERSION="scout_v1_$(date +%Y%m%d)"

ENTRY=$(python3 -c "
import json, sys
print(json.dumps({
  'ts': '${START_TS}',
  'agent': 'scout',
  'adapter_version': '${ADAPTER_VERSION}',
  'eval_loss': float('${NEW_LOSS}') if '${NEW_LOSS}' != 'null' else None,
  'examples_train': ${TRAIN_LINES},
  'examples_valid': ${VALID_LINES},
  'examples_test': ${TEST_LINES},
  'duration_sec': ${DURATION},
  'status': '${STATUS}'
}))
")
printf "%s\n" "${ENTRY}" >> "${RUNS_LOG}"
log "Training run metadata written to ${RUNS_LOG}."

# ─── Step 8: Final result ─────────────────────────────────────────────────────

if [[ "${STATUS}" == "rolled_back" ]]; then
  log "Scout training FAILED — adapter rolled back."
  exit 1
fi

log "Scout training complete."
