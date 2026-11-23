#!/usr/bin/env bash
# Fake devpod: records argv (and any --workspace-env-file contents) to $FAKE_LOG,
# then replays $FAKE_DIR/<cmd>[-<sub>].out with exit code from .code (default 0), or
# <cmd>[-<sub>].<N>.out/.code for its Nth call.
# shellcheck disable=SC2016
{
  printf 'ARGS'; printf ' %q' "$@"; printf '\n'
  # Which ssh-agent socket (if any) DevPod would forward on this call.
  if [ "$1" = ssh ]; then printf 'SOCK %s\n' "${SSH_AUTH_SOCK:-}"; fi
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--workspace-env-file" ]; then sed 's/^/ENV /' "$a"; fi
    prev="$a"
  done
} >>"$FAKE_LOG"
# FAKE_EXEC=1: run `ssh <id> --command <cmd>` for real (in bash), with stdin passed through
# unless FAKE_DROP_STDIN=1 (like an SSH transport that doesn't forward stdin).
if [ "$1" = ssh ] && [ -n "${FAKE_EXEC:-}" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--command" ]; then cmd="$a"; fi
    prev="$a"
  done
  if [ -n "${FAKE_DROP_STDIN:-}" ]; then exec </dev/null; fi
  exec bash -c "$cmd"
fi
key="$1"
case "$1" in provider) key="provider-$2" ;; status) key="status-$2" ;; esac
# Per-call answers: the Nth call uses <key>.N.out/.code/.err when any of them exists.
n=$(($(cat "$FAKE_DIR/$key.calls" 2>/dev/null || echo 0) + 1))
echo "$n" >"$FAKE_DIR/$key.calls"
if [ -f "$FAKE_DIR/$key.$n.out" ] || [ -f "$FAKE_DIR/$key.$n.code" ] || [ -f "$FAKE_DIR/$key.$n.err" ]; then key="$key.$n"; fi
[ -f "$FAKE_DIR/$key.err" ] && cat "$FAKE_DIR/$key.err" >&2
[ -f "$FAKE_DIR/$key.out" ] && cat "$FAKE_DIR/$key.out"
[ -f "$FAKE_DIR/$key.sleep" ] && sleep "$(cat "$FAKE_DIR/$key.sleep")"
exit "$(cat "$FAKE_DIR/$key.code" 2>/dev/null || echo 0)"
