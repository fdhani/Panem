#!/usr/bin/env bash
# postStartCommand: runs on every container start.
set -uo pipefail
dir="$(dirname "$0")"
"$dir/start-relay.sh" || echo "[panem] relay failed to start" >&2
"$dir/start-rc.sh" || echo "[panem] remote control failed to start" >&2
