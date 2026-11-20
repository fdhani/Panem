#!/usr/bin/env bash
# Fake devpod: records argv (and any --workspace-env-file contents) to $FAKE_LOG,
# then replays $FAKE_DIR/<cmd>[-<sub>].out with exit code from .code (default 0).
{
  printf 'ARGS'; printf ' %q' "$@"; printf '\n'
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--workspace-env-file" ]; then sed 's/^/ENV /' "$a"; fi
    prev="$a"
  done
} >>"$FAKE_LOG"
key="$1"
case "$1" in provider) key="provider-$2" ;; status) key="status-$2" ;; esac
[ -f "$FAKE_DIR/$key.err" ] && cat "$FAKE_DIR/$key.err" >&2
[ -f "$FAKE_DIR/$key.out" ] && cat "$FAKE_DIR/$key.out"
[ -f "$FAKE_DIR/$key.sleep" ] && sleep "$(cat "$FAKE_DIR/$key.sleep")"
exit "$(cat "$FAKE_DIR/$key.code" 2>/dev/null || echo 0)"
