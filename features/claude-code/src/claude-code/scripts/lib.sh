#!/usr/bin/env bash
# Shared helpers for the panem scripts. Sourced, not executed.

# shellcheck disable=SC1091
[ -f /usr/local/share/panem/feature.env ] && . /usr/local/share/panem/feature.env

PANEM_WORKSPACE_ROOT="${PANEM_WORKSPACE_ROOT:-/workspace}"
PANEM_STATE_DIR="$PANEM_WORKSPACE_ROOT/.panem"
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export PATH="$HOME/.local/bin:$PATH"

log() { printf '[panem] %s\n' "$*" >&2; }

# Claude Code names a project's folder after its path with every non-alphanumeric char as "-".
claude_project_dir() { printf '%s' "$1" | sed 's/[^A-Za-z0-9-]/-/g'; }

pod_json() {
  if [ -n "${PANEM_POD:-}" ]; then
    printf '%s' "$PANEM_POD"
  elif [ -f "$PANEM_STATE_DIR/pod.json" ]; then
    cat "$PANEM_STATE_DIR/pod.json"
  else
    echo '{}'
  fi
}

primary_repo_dir() {
  local name
  name="$(pod_json | jq -r '.repos[0].name // empty')"
  if [ -n "$name" ] && [ -d "$PANEM_WORKSPACE_ROOT/$name" ]; then
    printf '%s/%s' "$PANEM_WORKSPACE_ROOT" "$name"
  else
    printf '%s' "$PANEM_WORKSPACE_ROOT"
  fi
}
