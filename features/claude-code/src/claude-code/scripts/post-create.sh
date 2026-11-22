#!/usr/bin/env bash
# postCreateCommand: runs once, as the remote user, after the container is created.
# 1. Clone each repo at its ref into /workspace/<repo> (only pushed work is reachable).
# 2. Materialize context from the workspace repo into ~/.claude.
# 3. Pre-trust /workspace/* so Remote Control can start without a prompt.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

if [ ! -w "$PANEM_WORKSPACE_ROOT" ]; then
  # Image built before the user's UID was remapped: take ownership if sudo allows it.
  sudo -n mkdir -p "$PANEM_WORKSPACE_ROOT" 2>/dev/null || true
  sudo -n chown "$(id -u):$(id -g)" "$PANEM_WORKSPACE_ROOT" 2>/dev/null || true
fi
if [ ! -w "$PANEM_WORKSPACE_ROOT" ]; then
  echo "[panem] $PANEM_WORKSPACE_ROOT is not writable by $(id -un) ($(id -u)): $(ls -ld "$PANEM_WORKSPACE_ROOT")" >&2
  exit 1
fi
mkdir -p "$PANEM_STATE_DIR" "$CLAUDE_HOME"
# Keep a log inside the pod: lifecycle output is otherwise easy to lose.
exec > >(tee -a "$PANEM_STATE_DIR/post-create.log") 2>&1
log "post-create start: user=$(id -un) pwd=$PWD pod_env=${PANEM_POD:+set}"

POD="$(pod_json)"
CONTEXT_DIR="${PANEM_CONTEXT_DIR:-$PWD}"

# ---- 1. repos ----
count="$(printf '%s' "$POD" | jq '.repos | length // 0')"
for i in $(seq 0 $((count - 1))); do
  name="$(printf '%s' "$POD" | jq -r ".repos[$i].name")"
  url="$(printf '%s' "$POD" | jq -r ".repos[$i].url")"
  ref="$(printf '%s' "$POD" | jq -r ".repos[$i].ref")"
  dest="$PANEM_WORKSPACE_ROOT/$name"
  if [ -d "$dest/.git" ]; then
    log "repo $name already present, skipping clone"
    continue
  fi
  log "cloning $url@$ref -> $dest"
  if ! git clone --quiet --branch "$ref" -- "$url" "$dest" 2>/dev/null; then
    # Not a branch or tag: clone default branch, then check out the commit.
    git clone --quiet -- "$url" "$dest"
    git -C "$dest" checkout --quiet "$ref"
  fi
done

# ---- 2. context ----
if [ -f "$CONTEXT_DIR/CLAUDE.md" ]; then
  cp "$CONTEXT_DIR/CLAUDE.md" "$CLAUDE_HOME/CLAUDE.md"
fi
for dir in skills plans agents commands; do
  if [ -d "$CONTEXT_DIR/$dir" ]; then
    mkdir -p "$CLAUDE_HOME/$dir"
    cp -R "$CONTEXT_DIR/$dir/." "$CLAUDE_HOME/$dir/"
  fi
done
if [ -d "$CONTEXT_DIR/memory" ]; then
  for repo_mem in "$CONTEXT_DIR"/memory/*/; do
    [ -d "$repo_mem" ] || continue
    repo="$(basename "$repo_mem")"
    target="$CLAUDE_HOME/projects/$(claude_project_dir "$PANEM_WORKSPACE_ROOT/$repo")/memory"
    mkdir -p "$target"
    cp -R "$repo_mem." "$target/"
  done
fi

# ---- 3. claude settings: onboarding done, /workspace/* trusted ----
CLAUDE_JSON="$HOME/.claude.json"
[ -f "$CLAUDE_JSON" ] || echo '{}' >"$CLAUDE_JSON"
trusted="$(
  printf '%s' "$POD" | jq -c --arg root "$PANEM_WORKSPACE_ROOT" \
    '[.repos[]?.name | "\($root)/\(.)"] + [$root]'
)"
tmp="$(mktemp)"
jq --argjson dirs "$trusted" '
  .hasCompletedOnboarding = true
  | .projects = (.projects // {})
  | reduce $dirs[] as $d (.; .projects[$d] = ((.projects[$d] // {}) + {hasTrustDialogAccepted: true}))
' "$CLAUDE_JSON" >"$tmp"
mv "$tmp" "$CLAUDE_JSON"
chmod 600 "$CLAUDE_JSON"

# ---- 4. record pod metadata (used by controller rediscovery) ----
printf '%s\n' "$POD" | jq '.' >"$PANEM_STATE_DIR/pod.json"

# Persist secrets for later starts: backends may not re-inject env on start.
mkdir -p "$HOME/.config/panem"
(
  umask 077
  : >"$HOME/.config/panem/env"
  for var in CLAUDE_CODE_OAUTH_TOKEN PANEM_RELAY_SECRET; do
    if [ -n "${!var:-}" ]; then printf '%s=%q\n' "$var" "${!var}" >>"$HOME/.config/panem/env"; fi
  done
)
log "context ready"
