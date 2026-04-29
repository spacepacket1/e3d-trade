#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(pwd)}"
CODEX_BIN="${CODEX_BIN:-codex}"
SANDBOX_MODE="${SANDBOX_MODE:-workspace-write}"
APPROVAL_POLICY="${APPROVAL_POLICY:-on-request}"
MODE="${MODE:-exec}"
DEFAULT_MODEL="${DEFAULT_MODEL:-gpt-5.4}"
HIGH_MODEL="${HIGH_MODEL:-gpt-5.5}"
MINI_MODEL="${MINI_MODEL:-gpt-5.4-mini}"
MODEL_OVERRIDES="${MODEL_OVERRIDES:-}"
COMMON_READ_FILES="${COMMON_READ_FILES:-package.json}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runSpecPhasesCodex.sh <spec.md> <all|phase-number> [options]

Options:
  --from <n>           Start phase for "all"
  --to <n>             End phase for "all"
  --dry-run            Print prompts instead of running Codex
  --list               List detected phases and selected models
  --read <path>        Add a file to the "Start by reading" list; repeatable
  -h, --help           Show this help

Examples:
  scripts/runSpecPhasesCodex.sh docs/feature-ticket.md --list
  scripts/runSpecPhasesCodex.sh docs/feature-ticket.md 3 --dry-run
  scripts/runSpecPhasesCodex.sh docs/feature-ticket.md all --from 4 --to 8
  MODEL_OVERRIDES="4:gpt-5.5,7:gpt-5.4-mini" scripts/runSpecPhasesCodex.sh docs/feature-ticket.md all

Environment overrides:
  ROOT_DIR=/path/to/repo
  CODEX_BIN=codex
  SANDBOX_MODE=workspace-write
  APPROVAL_POLICY=on-request
  MODE=exec
  DEFAULT_MODEL=gpt-5.4
  HIGH_MODEL=gpt-5.5
  MINI_MODEL=gpt-5.4-mini
  MODEL_OVERRIDES="phase:model,phase:model"
  COMMON_READ_FILES="package.json pipeline.js server.js"

Expected spec format:
  Markdown headings containing a phase number, for example:
    ## Phase 1 — Historical Replay
    ## 6. Phase 2 - Walk-Forward Validation

Notes:
  - Each phase starts a fresh non-interactive Codex session.
  - "all" runs detected phases in numeric order, optionally bounded by --from/--to.
  - Model selection is heuristic and intentionally conservative; use MODEL_OVERRIDES for exact routing.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_spec() {
  [[ -f "$SPEC_FILE" ]] || die "spec file not found: $SPEC_FILE"
}

phase_lines() {
  awk '
    /^#{1,6}[[:space:]]+.*[Pp]hase[[:space:]]+[0-9]+/ {
      line = $0
      if (match(line, /[Pp]hase[[:space:]]+([0-9]+)/)) {
        rest = substr(line, RSTART, RLENGTH)
        gsub(/[^0-9]/, "", rest)
        phase = rest
        title = line
        sub(/^#{1,6}[[:space:]]+/, "", title)
        sub(/^[0-9]+[.][[:space:]]+/, "", title)
        sub(/^[Pp]hase[[:space:]]+[0-9]+[[:space:]]*[-—:]*[[:space:]]*/, "", title)
        print phase "\t" NR "\t" title
      }
    }
  ' "$SPEC_FILE" | sort -n -k1,1
}

phase_title() {
  local phase="$1"
  phase_lines | awk -F '\t' -v p="$phase" '$1 == p { print $3; exit }'
}

phase_exists() {
  local phase="$1"
  [[ -n "$(phase_title "$phase")" ]]
}

first_phase() {
  phase_lines | awk -F '\t' 'NR == 1 { print $1 }'
}

last_phase() {
  phase_lines | awk -F '\t' 'END { print $1 }'
}

extract_phase_body() {
  local phase="$1"
  awk -v target="$phase" '
    function phase_number(line,    copy) {
      copy = line
      if (copy !~ /^#{1,6}[[:space:]]+.*[Pp]hase[[:space:]]+[0-9]+/) return ""
      sub(/^.*[Pp]hase[[:space:]]+/, "", copy)
      sub(/[^0-9].*$/, "", copy)
      return copy
    }
    {
      p = phase_number($0)
      if (p != "") {
        if (found && p != target) exit
        if (p == target) found = 1
      }
      if (found) print
    }
  ' "$SPEC_FILE"
}

override_model() {
  local phase="$1"
  local item key value
  [[ -n "$MODEL_OVERRIDES" ]] || return 1
  local items=()
  IFS=',' read -r -a items <<< "$MODEL_OVERRIDES"
  for item in "${items[@]}"; do
    key="${item%%:*}"
    value="${item#*:}"
    if [[ "$key" == "$phase" && -n "$value" && "$value" != "$item" ]]; then
      echo "$value"
      return 0
    fi
  done
  return 1
}

phase_model() {
  local phase="$1"
  local title body lower title_lower
  if override_model "$phase"; then return 0; fi

  title="$(phase_title "$phase")"
  title_lower="$(printf '%s\n' "$title" | tr '[:upper:]' '[:lower:]')"
  body="$(extract_phase_body "$phase")"
  lower="$(printf '%s\n%s\n' "$title" "$body" | tr '[:upper:]' '[:lower:]')"

  if grep -Eq 'custody|wallet|key-management|liquidity|routing|mev|gas|reconciliation|accounting|tax|compliance|permission|audit' <<< "$title_lower"; then
    echo "$HIGH_MODEL"
  elif grep -Eq 'dashboard|operations|monitoring|alerts|incidents|analytics|data quality|risk engine|token.*scanner|execution simulation|historical|backtesting|walk-forward|promotion' <<< "$title_lower"; then
    echo "$DEFAULT_MODEL"
  elif grep -Eq 'private key|key-management|live routing|cancel/replace|cancel and replace|mev|gas-aware|tax-lot|reconciliation|compliance|operator permission' <<< "$lower"; then
    echo "$HIGH_MODEL"
  elif grep -Eq 'small ui|minor ui|simple api|copy change|documentation only|docs only' <<< "$lower"; then
    echo "$MINI_MODEL"
  else
    echo "$DEFAULT_MODEL"
  fi
}

read_files_block() {
  local files=()
  local file
  # shellcheck disable=SC2206
  files=($COMMON_READ_FILES)
  if [[ ${#EXTRA_READ_FILES[@]} -gt 0 ]]; then
    files+=("${EXTRA_READ_FILES[@]}")
  fi

  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi

  echo "Start by reading:"
  echo "- ${SPEC_FILE}"
  for file in "${files[@]}"; do
    [[ -n "$file" ]] && echo "- $file"
  done
  echo
}

phase_prompt() {
  local phase="$1"
  local title
  title="$(phase_title "$phase")"
  [[ -n "$title" ]] || die "phase not found in spec: $phase"

  cat <<EOF
We are in ${ROOT_DIR}.

Please implement Phase ${phase} from ${SPEC_FILE}:
${title}.

Keep changes scoped. Preserve existing behavior. Do not touch node_modules. Do not implement later phases.

$(read_files_block)
Context:
This is one phase from a larger feature ticket. If this is a resume after a rate limit or interrupted run, first inspect the current working tree and continue the interrupted phase rather than restarting completed work.

General acceptance criteria:
- Use the existing codebase patterns.
- Keep edits scoped to this phase.
- Preserve existing behavior unless the phase explicitly requires a change.
- Add or update tests/checks where appropriate.
- Run verification before finishing.
- Do not implement later phases from the spec.

Relevant phase section from the spec:

$(extract_phase_body "$phase")
EOF
}

list_phases() {
  local line phase title model
  phase_lines | while IFS=$'\t' read -r phase _line title; do
    model="$(phase_model "$phase")"
    printf 'Phase %s\t%s\t%s\n' "$phase" "$model" "$title"
  done
}

run_phase() {
  local phase="$1"
  local dry_run="$2"
  local model title
  title="$(phase_title "$phase")"
  [[ -n "$title" ]] || die "phase not found in spec: $phase"
  model="$(phase_model "$phase")"

  echo "== Phase ${phase}: ${title} =="
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

SPEC_FILE=""
TARGET=""
DRY_RUN="0"
LIST_ONLY="0"
FROM_PHASE=""
TO_PHASE=""
EXTRA_READ_FILES=()

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

SPEC_FILE="$1"
shift

if [[ $# -gt 0 && "$1" != --* ]]; then
  TARGET="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --list)
      LIST_ONLY="1"
      shift
      ;;
    --from)
      [[ $# -ge 2 ]] || die "--from requires a phase number"
      FROM_PHASE="$2"
      shift 2
      ;;
    --from=*)
      FROM_PHASE="${1#--from=}"
      shift
      ;;
    --to)
      [[ $# -ge 2 ]] || die "--to requires a phase number"
      TO_PHASE="$2"
      shift 2
      ;;
    --to=*)
      TO_PHASE="${1#--to=}"
      shift
      ;;
    --read)
      [[ $# -ge 2 ]] || die "--read requires a path"
      EXTRA_READ_FILES+=("$2")
      shift 2
      ;;
    --read=*)
      EXTRA_READ_FILES+=("${1#--read=}")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_spec

if [[ -z "$(phase_lines)" ]]; then
  die "no phase headings found in $SPEC_FILE"
fi

if [[ "$LIST_ONLY" == "1" ]]; then
  list_phases
  exit 0
fi

if [[ -z "$TARGET" ]]; then
  die "missing target: use all, a phase number, or --list"
fi

if [[ "$TARGET" == "all" ]]; then
  FROM_PHASE="${FROM_PHASE:-$(first_phase)}"
  TO_PHASE="${TO_PHASE:-$(last_phase)}"
  [[ "$FROM_PHASE" =~ ^[0-9]+$ ]] || die "invalid --from phase: $FROM_PHASE"
  [[ "$TO_PHASE" =~ ^[0-9]+$ ]] || die "invalid --to phase: $TO_PHASE"
  (( FROM_PHASE <= TO_PHASE )) || die "--from must be <= --to"

  phase_lines | while IFS=$'\t' read -r phase _line _title; do
    if (( phase >= FROM_PHASE && phase <= TO_PHASE )); then
      run_phase "$phase" "$DRY_RUN"
    fi
  done
else
  [[ "$TARGET" =~ ^[0-9]+$ ]] || die "target must be all or a phase number"
  phase_exists "$TARGET" || die "phase not found in spec: $TARGET"
  run_phase "$TARGET" "$DRY_RUN"
fi
