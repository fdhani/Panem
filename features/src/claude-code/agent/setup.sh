#!/usr/bin/env bash
# Claude Code agent: one-time setup (run by the base's post-create, after the repos are cloned).
# Marks onboarding done, trusts /codebase/* and skips Remote Control's first-run question, so
# Remote Control can start without a prompt.
set -euo pipefail
# shellcheck source=../../panem/scripts/lib.sh
. "$(dirname "$0")/../../lib.sh"

CLAUDE_JSON="$HOME/.claude.json"
[ -f "$CLAUDE_JSON" ] || echo '{}' >"$CLAUDE_JSON"
trusted="$(
  pod_json | jq -c --arg root "$PANEM_CODE_ROOT" '[.repos[]?.name | "\($root)/\(.)"] + [$root]'
)"
# remoteDialogSeen is undocumented (found in Claude Code 2.1.330): without it,
# `claude remote-control` first asks "Enable Remote Control? (y/n)". start.sh sets it again for
# pods set up before this. remoteControlMachineId is left for Claude to generate.
tmp="$(mktemp)"
jq --argjson dirs "$trusted" '
  .hasCompletedOnboarding = true
  | .remoteDialogSeen = true
  | .projects = (.projects // {})
  | reduce $dirs[] as $d (.; .projects[$d] = ((.projects[$d] // {}) + {hasTrustDialogAccepted: true}))
' "$CLAUDE_JSON" >"$tmp"
mv "$tmp" "$CLAUDE_JSON"
chmod 600 "$CLAUDE_JSON"
