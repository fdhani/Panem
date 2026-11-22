#!/usr/bin/env bash
# Shared helpers for the Panem base scripts and for agent hooks. Sourced, not executed.
# Agent hooks live in <share>/agents/<id>/ and source this as "$(dirname "$0")/../../lib.sh".

# Where the base scripts are installed (/usr/local/share/panem in a pod).
PANEM_SHARE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEM_AGENTS_DIR="${PANEM_AGENTS_DIR:-$PANEM_SHARE/agents}"

# Secrets saved at create time (agent credentials, the relay secret): restore any that the
# live environment doesn't already set. Backends may not re-inject env on later starts.
PANEM_SAVED_ENV="$HOME/.config/panem/env"
if [ -f "$PANEM_SAVED_ENV" ]; then
  while IFS= read -r _line; do
    _name="${_line%%=*}"
    [[ "$_name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    if [ -z "${!_name:-}" ]; then
      # Values were written with printf %q, so eval restores them exactly.
      eval "export $_line"
    fi
  done <"$PANEM_SAVED_ENV"
  unset _line _name
fi

# Code repos live here, at the same path on every machine (Claude names its per-project memory
# folders after it). PANEM_WORKSPACE_ROOT is the name used before the /codebase rename.
PANEM_CODE_ROOT="${PANEM_CODE_ROOT:-${PANEM_WORKSPACE_ROOT:-/codebase}}"
# Panem's own per-pod files (pod.json, logs): outside the code tree, so never committed.
PANEM_STATE_DIR="${PANEM_STATE_DIR:-$HOME/.panem}"
# Where pods created before the rename kept their state.
PANEM_LEGACY_STATE_DIR=/workspace/.panem
export PATH="$HOME/.local/bin:$PATH"

log() { printf '[panem] %s\n' "$*" >&2; }

pod_json() {
  if [ -n "${PANEM_POD:-}" ]; then
    printf '%s' "$PANEM_POD"
  elif [ -f "$PANEM_STATE_DIR/pod.json" ]; then
    cat "$PANEM_STATE_DIR/pod.json"
  elif [ -f "$PANEM_LEGACY_STATE_DIR/pod.json" ]; then
    cat "$PANEM_LEGACY_STATE_DIR/pod.json"
  else
    echo '{}'
  fi
}

primary_repo_dir() {
  local name
  name="$(pod_json | jq -r '.repos[0].name // empty')"
  if [ -n "$name" ] && [ -d "$PANEM_CODE_ROOT/$name" ]; then
    printf '%s/%s' "$PANEM_CODE_ROOT" "$name"
  else
    printf '%s' "$PANEM_CODE_ROOT"
  fi
}
