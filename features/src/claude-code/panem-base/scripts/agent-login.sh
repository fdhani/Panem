#!/usr/bin/env bash
# Run an agent's own sign-in flow in this terminal: agent-login.sh <agent id>.
# The command comes from the agent's agent.json ("login.command"); the person completes it
# themselves (e.g. opens the printed URL and pastes the code back). Panem never sees the result.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

id="${1:?usage: agent-login.sh <agent id>}"
[[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "panem: bad agent id $id" >&2; exit 2; }
dir="$PANEM_AGENTS_DIR/$id"
cmd="$(jq -r '.login.command // empty' "$dir/agent.json" 2>/dev/null || true)"
[ -n "$cmd" ] || { echo "panem: agent $id has no sign-in command" >&2; exit 2; }
# Sign in straight into the machine's shared volume, so other pods on it can use the login.
link_agent_logins "$dir"
cd "$HOME"
exec bash -c "$cmd"
