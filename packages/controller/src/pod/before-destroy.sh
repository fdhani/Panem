#!/usr/bin/env bash
# Runs inside a pod before it's deleted, sent by the controller (not part of the Feature).
# Runs every installed agent's before-destroy.sh (in name order), then the template's
# beforeDestroy command, each from the code root, as the pod user. Anything other than agent
# memory that should outlive the pod (e.g. specs in a git overlay) is pushed from here.
#
# Usage: before-destroy.sh SECONDS_PER_HOOK [TEMPLATE_COMMAND]
# The first failing hook stops the run (exit 1) with its last output lines on stderr, and the
# pod is kept. Full output: ~/.panem/before-destroy.log
set -uo pipefail
limit="$1"
template_cmd="${2:-}"
agents="${PANEM_AGENTS_DIR:-/usr/local/share/panem/agents}"
code="${PANEM_CODE_ROOT:-/codebase}"
log="$HOME/.panem/before-destroy.log"
mkdir -p "$(dirname "$log")"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# Saved credentials (agent tokens), as the agent's other hooks see them.
if [ -f "$agents/../lib.sh" ]; then
  # shellcheck disable=SC1091
  . "$agents/../lib.sh"
fi

run_hook() { # name, command...
  local name="$1"
  shift
  printf '== %s (%s)\n' "$name" "$(date -u +%FT%TZ)" >>"$log"
  timeout "$limit" "$@" >"$out" 2>&1
  local rc=$?
  cat "$out" >>"$log"
  if [ "$rc" -eq 0 ]; then return 0; fi
  tail -n 15 "$out" >&2
  if [ "$rc" -eq 124 ]; then
    echo "panem: before-destroy hook ($name) timed out after ${limit}s" >&2
  else
    echo "panem: before-destroy hook ($name) failed with exit $rc" >&2
  fi
  exit 1
}

cd "$code" 2>/dev/null || cd "$HOME" || exit 1
for dir in "$agents"/*/; do
  [ -x "$dir/before-destroy.sh" ] || continue
  run_hook "agent $(basename "$dir")" "$dir/before-destroy.sh"
done
if [ -n "$template_cmd" ]; then
  run_hook "template" bash -c "$template_cmd"
fi
