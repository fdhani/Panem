#!/usr/bin/env bash
# Claude Code agent: one-time setup (run by the base's post-create, after the repos are cloned).
# Marks onboarding done and trusts /codebase/* so Remote Control can start without a prompt.
set -euo pipefail
# shellcheck source=../../panem/scripts/lib.sh
. "$(dirname "$0")/../../lib.sh"

CLAUDE_JSON="$HOME/.claude.json"
[ -f "$CLAUDE_JSON" ] || echo '{}' >"$CLAUDE_JSON"
trusted="$(
  pod_json | jq -c --arg root "$PANEM_CODE_ROOT" '[.repos[]?.name | "\($root)/\(.)"] + [$root]'
)"
tmp="$(mktemp)"
jq --argjson dirs "$trusted" '
  .hasCompletedOnboarding = true
  | .projects = (.projects // {})
  | reduce $dirs[] as $d (.; .projects[$d] = ((.projects[$d] // {}) + {hasTrustDialogAccepted: true}))
' "$CLAUDE_JSON" >"$tmp"
mv "$tmp" "$CLAUDE_JSON"
chmod 600 "$CLAUDE_JSON"
