#!/usr/bin/env bash
# Starts the port relay that the machine's panem-forwarder connects to. Never published.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

SESSION=panem-relay
if [ -z "${PANEM_RELAY_SECRET:-}" ]; then
  log "no PANEM_RELAY_SECRET; port relay not started"
  exit 0
fi
if ! command -v socat >/dev/null; then
  log "socat not found; port relay not started"
  exit 0
fi
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" \
  -e "PANEM_RELAY_SECRET=$PANEM_RELAY_SECRET" \
  -e "PANEM_WORKSPACE_ROOT=$PANEM_WORKSPACE_ROOT" \
  -e "PANEM_RELAY_PORT=${PANEM_RELAY_PORT:-7699}" \
  -e "PATH=$PATH" \
  "socat TCP-LISTEN:${PANEM_RELAY_PORT:-7699},fork,reuseaddr SYSTEM:'$(dirname "$0")/relay-conn.sh'"
log "port relay listening on :${PANEM_RELAY_PORT:-7699}"
