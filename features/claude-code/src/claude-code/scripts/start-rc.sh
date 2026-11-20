#!/usr/bin/env bash
# postStartCommand: runs on every container start, so Remote Control survives stop/start.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

SESSION=panem-rc
[ "${PANEM_REMOTE_CONTROL:-true}" = "true" ] || exit 0

if ! command -v claude >/dev/null; then
  log "claude not found on PATH; Remote Control not started"
  exit 0
fi
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "$CLAUDE_HOME/.credentials.json" ]; then
  log "no CLAUDE_CODE_OAUTH_TOKEN and no stored login; Remote Control not started"
  exit 0
fi

name="$(pod_json | jq -r '.id // empty')"
name="${name:-$(hostname)}"
dir="$(primary_repo_dir)"

tmux kill-session -t "$SESSION" 2>/dev/null || true
mkdir -p "$PANEM_STATE_DIR"
# Pass the token through tmux explicitly: the tmux server may predate the env.
tmux new-session -d -s "$SESSION" -c "$dir" \
  -e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}" \
  -e "PATH=$PATH" \
  "claude remote-control --name '$name' --permission-mode '${PANEM_PERMISSION_MODE:-default}' 2>&1 | tee -a '$PANEM_STATE_DIR/remote-control.log'"
log "Remote Control started in tmux session $SESSION ($dir)"
