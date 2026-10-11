#!/usr/bin/env bash
set -euo pipefail

# Scheduled JEV-gated discover/ideate pass. Cron does not load ~/.zshrc, so
# PATH and provider credentials must be set here (same pattern as
# e3d-pilot/ops/run/run-fleet-discover.sh).
export PATH="${HOME}/.grok/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export GROK_BUILD_BIN="${GROK_BUILD_BIN:-${HOME}/.grok/bin/grok}"
export CLAUDE_MODEL="${CLAUDE_MODEL:-haiku}"

# Claude Code tokens live in the login shell. ~/.e3d-pilot-providers.env
# (mode 600) carries the same exports so cron can authenticate Claude --
# currently the metered API key, not the interactive subscription token.
if [[ -f "${HOME}/.e3d-pilot-providers.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.e3d-pilot-providers.env"
  set +a
fi

cd /Users/mini/e3d-trade
exec /usr/local/bin/node scripts/runJevGatedDiscoverIdeate.js "$@"
