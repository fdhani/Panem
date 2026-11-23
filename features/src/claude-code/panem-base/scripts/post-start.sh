#!/usr/bin/env bash
# postStartCommand: runs on every container start. Starts the port relay, then every installed
# agent's start hook (<share>/agents/<id>/start.sh). One agent failing doesn't stop the others.
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# PANEM_ONLY_AGENT=<id>: restart just that agent (after a sign-in), leaving the relay alone.
if [ -z "${PANEM_ONLY_AGENT:-}" ]; then
  "$PANEM_SHARE/start-relay.sh" || log "relay failed to start"
fi
for agent in "$PANEM_AGENTS_DIR"/*/; do
  [ -d "$agent" ] || continue
  if [ -n "${PANEM_ONLY_AGENT:-}" ] && [ "$(basename "$agent")" != "$PANEM_ONLY_AGENT" ]; then continue; fi
  link_agent_logins "${agent%/}" || log "agent $(basename "$agent"): could not link its sign-in"
  if [ -x "$agent/start.sh" ]; then
    "$agent/start.sh" || log "agent $(basename "$agent"): start hook failed"
  fi
done
