#!/usr/bin/env bash
# Panem pod base. Runs as root at image build time. Agent Features carry a copy of this
# (panem-base/) and run it when the base isn't installed yet, so a template can list just an
# agent Feature.
set -euo pipefail

REMOTE_USER="${_REMOTE_USER:-root}"
# Overridable for tests only; pods always use the defaults.
SHARE="${PANEM_INSTALL_SHARE:-/usr/local/share/panem}"
CODE_ROOT="${PANEM_INSTALL_CODE_ROOT:-/codebase}"
VERSION="$(cat "$(dirname "$0")/VERSION")"

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

mkdir -p "$SHARE/agents"
cp "$(dirname "$0")"/scripts/*.sh "$SHARE/"
chmod 755 "$SHARE"/*.sh
printf '%s\n' "$VERSION" >"$SHARE/VERSION"
# Which build of Panem's Features this image has (the panemBuild option), checked at setup.
if [ -n "${PANEMBUILD:-}" ]; then printf '%s\n' "$PANEMBUILD" >"$SHARE/BUILD"; fi

mkdir -p "$CODE_ROOT"
chown "$REMOTE_USER" "$CODE_ROOT" 2>/dev/null || true
# Devcontainer tooling may remap the user's UID to the host's after this build step, which
# would leave /codebase owned by a stale UID. Sticky + world-writable (like /tmp) avoids that.
chmod 1777 "$CODE_ROOT"
