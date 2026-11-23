#!/usr/bin/env bash
# Claude Code agent: start hook (run by the base's post-start on every container start), so
# Remote Control survives stop/start.
set -euo pipefail
# shellcheck source=../../panem/scripts/lib.sh
. "$(dirname "$0")/../../lib.sh"
# Options chosen in devcontainer.json (installed by install.sh).
# shellcheck disable=SC1091
[ -f "$(dirname "$0")/agent.env" ] && . "$(dirname "$0")/agent.env"

SESSION=panem-rc
LOGFILE="$PANEM_STATE_DIR/remote-control.log"
if [ "${PANEM_REMOTE_CONTROL:-true}" != "true" ]; then
  agent_status stopped "Remote Control is turned off for this template"
  exit 0
fi
if ! command -v claude >/dev/null; then
  log "claude not found on PATH; Remote Control not started"
  agent_status error "Claude Code isn't installed in this pod"
  exit 0
fi

# Remote Control needs a claude.ai sign-in: a setup-token (CLAUDE_CODE_OAUTH_TOKEN) only covers
# model requests, and when set it takes precedence over the sign-in, so it's left out here.
method="$(env -u CLAUDE_CODE_OAUTH_TOKEN claude auth status --json 2>/dev/null | jq -r '.authMethod // empty' 2>/dev/null || true)"
if [ "$method" != "claude.ai" ]; then
  log "Remote Control needs a claude.ai sign-in; not started"
  why="Remote Control needs a claude.ai sign-in (a setup-token only covers model requests)"
  # Whether a sign-in here would cover the machine's other pods (see link_agent_logins).
  unshared="$(jq -r 'select(.shared == false) | .reason // empty' "$PANEM_STATE_DIR/agents/$(agent_id).login.json" 2>/dev/null || true)"
  [ -z "$unshared" ] || why="$why. This pod can't use the machine's sign-in: $unshared"
  agent_status needs-login "$why"
  exit 0
fi

name="$(pod_json | jq -r '.id // empty')"
name="${name:-$(hostname)}"
dir="$(primary_repo_dir)"

tmux kill-session -t "$SESSION" 2>/dev/null || true
mkdir -p "$PANEM_STATE_DIR"
tmux new-session -d -s "$SESSION" -c "$dir" \
  -e "PATH=$PATH" \
  "env -u CLAUDE_CODE_OAUTH_TOKEN claude remote-control --name '$name' --permission-mode '${PANEM_PERMISSION_MODE:-default}' 2>&1 | tee -a '$LOGFILE'"

# Remote Control exits at once when it can't start (e.g. sign-in rejected): say so on the card.
sleep "${PANEM_RC_SETTLE_SECONDS:-5}"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  agent_status running ""
  log "Remote Control started in tmux session $SESSION ($dir)"
else
  why="$(grep -v '^\s*$' "$LOGFILE" 2>/dev/null | tail -n 1 || true)"
  agent_status error "Remote Control stopped: ${why:-no output}"
  log "Remote Control exited: $why"
fi
