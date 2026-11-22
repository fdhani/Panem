#!/usr/bin/env bash
# Shared helpers for the panem scripts. Sourced, not executed.

# shellcheck disable=SC1091
[ -f /usr/local/share/panem/feature.env ] && . /usr/local/share/panem/feature.env

if [ -f "$HOME/.config/panem/env" ]; then
  _tok="${CLAUDE_CODE_OAUTH_TOKEN:-}" _sec="${PANEM_RELAY_SECRET:-}"
  # shellcheck disable=SC1091
  . "$HOME/.config/panem/env"
  # Values from the live environment win over the saved ones.
  CLAUDE_CODE_OAUTH_TOKEN="${_tok:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
  PANEM_RELAY_SECRET="${_sec:-${PANEM_RELAY_SECRET:-}}"
  export CLAUDE_CODE_OAUTH_TOKEN PANEM_RELAY_SECRET
  unset _tok _sec
fi

# Code repos live here, at the same path on every machine (Claude names its per-project memory
# folders after it). PANEM_WORKSPACE_ROOT is the name used before the /codebase rename.
PANEM_CODE_ROOT="${PANEM_CODE_ROOT:-${PANEM_WORKSPACE_ROOT:-/codebase}}"
# Panem's own per-pod files (pod.json, logs): outside the code tree, so never committed.
PANEM_STATE_DIR="${PANEM_STATE_DIR:-$HOME/.panem}"
# Where pods created before the rename kept their state.
PANEM_LEGACY_STATE_DIR=/workspace/.panem
# shellcheck disable=SC2034 # used by the scripts that source this file
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
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
