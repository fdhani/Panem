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

# ---- agents: status and shared sign-ins (the agent contract, features/README.md) ----

# A Docker volume per machine (mounted here by the controller's generated config) that keeps
# agents' sign-in files, so one sign-in serves every pod on that machine.
PANEM_LOGINS_DIR="${PANEM_LOGINS_DIR:-/var/lib/panem/logins}"

# The calling agent's id: its folder's name (hooks live in <share>/agents/<id>/).
agent_id() {
  printf '%s' "${PANEM_AGENT_ID:-$(basename "$(cd "$(dirname "$0")" && pwd)")}"
}

# Report how an agent is doing, for the pod card:
#   agent_status running|needs-login|stopped|error [message]
agent_status() {
  local id dir
  id="$(agent_id)"
  dir="$PANEM_STATE_DIR/agents"
  mkdir -p "$dir"
  jq -n --arg id "$id" --arg state "$1" --arg message "${2:-}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, state: $state, message: $message, at: $at}' >"$dir/$id.status.json.tmp" &&
    mv "$dir/$id.status.json.tmp" "$dir/$id.status.json"
}

# Keep an agent's sign-in files (agent.json "login.share", relative to $HOME) in the machine's
# volume, linked from where the agent expects them. A login already in the pod moves there if
# the volume has none yet. Without the volume, nothing changes.
link_agent_logins() {
  local dir="$1" id rel src dst
  id="$(basename "$dir")"
  [ -f "$dir/agent.json" ] && [ -d "$PANEM_LOGINS_DIR" ] && [ -w "$PANEM_LOGINS_DIR" ] || return 0
  while IFS= read -r rel; do
    case "$rel" in "" | /* | *..*) continue ;; esac
    src="$HOME/$rel"
    dst="$PANEM_LOGINS_DIR/$id/$rel"
    mkdir -p "$(dirname "$dst")" "$(dirname "$src")"
    chmod 700 "$PANEM_LOGINS_DIR/$id" 2>/dev/null || true
    if [ -f "$src" ] && [ ! -L "$src" ]; then
      if [ ! -e "$dst" ]; then mv "$src" "$dst"; else rm -f "$src"; fi
    fi
    [ "$(readlink "$src" 2>/dev/null)" = "$dst" ] || ln -sfn "$dst" "$src"
  done < <(jq -r '.login.share[]? // empty' "$dir/agent.json" 2>/dev/null)
}
