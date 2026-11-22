#!/usr/bin/env bash
# Runs as root at image build time.
set -euo pipefail

INSTALL_CLAUDE="${INSTALLCLAUDE:-true}"
REMOTE_CONTROL="${REMOTECONTROL:-true}"
PERMISSION_MODE="${PERMISSIONMODE:-default}"
REMOTE_USER="${_REMOTE_USER:-root}"
SHARE=/usr/local/share/panem

install_packages() {
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends git tmux jq curl socat ca-certificates
    rm -rf /var/lib/apt/lists/*
  elif command -v apk >/dev/null; then
    apk add --no-cache git tmux jq curl socat ca-certificates bash
  elif command -v dnf >/dev/null; then
    dnf install -y git tmux jq curl socat ca-certificates
  else
    echo "panem: unsupported base image (need apt, apk, or dnf)" >&2
    exit 1
  fi
}

missing=0
for bin in git tmux jq curl socat; do command -v "$bin" >/dev/null || missing=1; done
[ "$missing" = 1 ] && install_packages

mkdir -p "$SHARE"
cp "$(dirname "$0")"/scripts/*.sh "$SHARE/"
chmod 755 "$SHARE"/*.sh

cat >"$SHARE/feature.env" <<ENV
PANEM_REMOTE_CONTROL=${REMOTE_CONTROL}
PANEM_PERMISSION_MODE=${PERMISSION_MODE}
ENV

mkdir -p /workspace
chown "$REMOTE_USER" /workspace 2>/dev/null || true
# Devcontainer tooling may remap the user's UID to the host's after this build step, which
# would leave /workspace owned by a stale UID. Sticky + world-writable (like /tmp) avoids that.
chmod 1777 /workspace

if [ "$INSTALL_CLAUDE" = "true" ]; then
  # Install for the remote user so updates and ~/.local/bin land in their home.
  if [ "$REMOTE_USER" = "root" ]; then
    curl -fsSL https://claude.ai/install.sh | bash
  else
    su - "$REMOTE_USER" -c 'curl -fsSL https://claude.ai/install.sh | bash'
  fi
fi
