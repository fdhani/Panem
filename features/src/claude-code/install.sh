#!/usr/bin/env bash
# Claude Code agent Feature. Runs as root at image build time.
# Installs the Panem base first if it isn't there (or is older than the copy carried here in
# panem-base/), so a template can list just this Feature. Then registers the agent's hooks in
# /usr/local/share/panem/agents/claude-code/.
set -euo pipefail

INSTALL_CLAUDE="${INSTALLCLAUDE:-true}"
REMOTE_CONTROL="${REMOTECONTROL:-true}"
PERMISSION_MODE="${PERMISSIONMODE:-default}"
REMOTE_USER="${_REMOTE_USER:-root}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Overridable for tests only; pods always use the default.
SHARE="${PANEM_INSTALL_SHARE:-/usr/local/share/panem}"
AGENT="$SHARE/agents/claude-code"

vendored="$(cat "$HERE/panem-base/VERSION")"
installed="$(cat "$SHARE/VERSION" 2>/dev/null || echo 0)"
newest="$(printf '%s\n%s\n' "$installed" "$vendored" | sort -V | tail -n 1)"
if [ ! -x "$SHARE/post-create.sh" ] || { [ "$newest" = "$vendored" ] && [ "$installed" != "$vendored" ]; }; then
  echo "panem: installing the pod base $vendored (found: $installed)"
  bash "$HERE/panem-base/install.sh"
fi

# Which build of Panem's Features this image has (the panemBuild option), checked at setup.
if [ -n "${PANEMBUILD:-}" ]; then printf '%s\n' "$PANEMBUILD" >"$SHARE/BUILD"; fi

mkdir -p "$AGENT"
cp "$HERE"/agent/* "$AGENT/"
chmod 755 "$AGENT"/*.sh
cat >"$AGENT/agent.env" <<ENV
PANEM_REMOTE_CONTROL=${REMOTE_CONTROL}
PANEM_PERMISSION_MODE=${PERMISSION_MODE}
ENV

if [ "$INSTALL_CLAUDE" = "true" ]; then
  # Install for the remote user so updates and ~/.local/bin land in their home.
  if [ "$REMOTE_USER" = "root" ]; then
    curl -fsSL https://claude.ai/install.sh | bash
  else
    su - "$REMOTE_USER" -c 'curl -fsSL https://claude.ai/install.sh | bash'
  fi
fi
