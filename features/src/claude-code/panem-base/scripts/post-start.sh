#!/usr/bin/env bash
# postStartCommand: runs on every container start. Starts the port relay, then every installed
# agent's start hook (<share>/agents/<id>/start.sh). One agent failing doesn't stop the others.
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

"$PANEM_SHARE/start-relay.sh" || log "relay failed to start"
for agent in "$PANEM_AGENTS_DIR"/*/; do
  [ -d "$agent" ] || continue
  if [ -x "$agent/start.sh" ]; then
    "$agent/start.sh" || log "agent $(basename "$agent"): start hook failed"
  fi
done
