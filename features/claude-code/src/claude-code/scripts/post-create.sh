#!/usr/bin/env bash
# postCreateCommand: runs once, as the remote user, after the container is created.
# 1. Clone each repo at its ref into /codebase/<repo> (only pushed work is reachable).
# 2. (Synced files arrive later: the controller copies them in, per its sync rules.)
# 3. Pre-trust /codebase/* so Remote Control can start without a prompt.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# State lives in $HOME, so the log works even if the code root below can't be set up.
mkdir -p "$PANEM_STATE_DIR" "$CLAUDE_HOME"
# Keep a log inside the pod: lifecycle output is otherwise easy to lose.
exec > >(tee -a "$PANEM_STATE_DIR/post-create.log") 2>&1
log "post-create start: user=$(id -un) pwd=$PWD pod_env=${PANEM_POD:+set}"

# Usually the Feature created it at build time; otherwise try without privileges first.
mkdir -p "$PANEM_CODE_ROOT" 2>/dev/null || true
if [ ! -w "$PANEM_CODE_ROOT" ]; then
  # Missing and not creatable, or built before the user's UID was remapped: use sudo if allowed.
  sudo -n mkdir -p "$PANEM_CODE_ROOT" 2>/dev/null || true
  sudo -n chown "$(id -u):$(id -g)" "$PANEM_CODE_ROOT" 2>/dev/null || true
fi
if [ ! -w "$PANEM_CODE_ROOT" ]; then
  echo "[panem] $PANEM_CODE_ROOT is not writable by $(id -un) ($(id -u)): $(ls -ld "$PANEM_CODE_ROOT" 2>&1)" >&2
  exit 1
fi

POD="$(pod_json)"

# ---- 1. repos ----
count="$(printf '%s' "$POD" | jq '.repos | length // 0')"
for i in $(seq 0 $((count - 1))); do
  name="$(printf '%s' "$POD" | jq -r ".repos[$i].name")"
  url="$(printf '%s' "$POD" | jq -r ".repos[$i].url")"
  ref="$(printf '%s' "$POD" | jq -r ".repos[$i].ref")"
  dest="$PANEM_CODE_ROOT/$name"
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
# CLAUDE.md, skills, memory and any other synced files are copied in by the controller after
# this script and before the start hook, following the workspace repo's sync rules.

# ---- 3. claude settings: onboarding done, /codebase/* trusted ----
CLAUDE_JSON="$HOME/.claude.json"
[ -f "$CLAUDE_JSON" ] || echo '{}' >"$CLAUDE_JSON"
trusted="$(
  printf '%s' "$POD" | jq -c --arg root "$PANEM_CODE_ROOT" \
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
