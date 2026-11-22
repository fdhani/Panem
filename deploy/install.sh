#!/usr/bin/env bash
# Install the panem binary and its systemd user service on the controller host.
# Usage: deploy/install.sh [path/to/panem]
set -euo pipefail

BIN_SRC="${1:-dist/panem}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -x "$BIN_SRC" ] || { echo "binary not found: $BIN_SRC (run \`bun run build\`)" >&2; exit 1; }

for dep in devpod git docker tailscale; do
  command -v "$dep" >/dev/null || echo "warning: $dep not found on PATH" >&2
done

install -Dm755 "$BIN_SRC" "$HOME/.local/bin/panem"
install -Dm644 "$HERE/panem.service" "$HOME/.config/systemd/user/panem.service"

# Let the user service run without an active login session (always-on server).
if command -v loginctl >/dev/null; then
  me="$(id -un)"
  loginctl enable-linger "$me" 2>/dev/null || sudo loginctl enable-linger "$me" || true
fi

if [ ! -f "${PANEM_CONFIG:-$HOME/.config/panem/config.json}" ]; then
  cat <<MSG
Installed. Next:
  1. panem init                              # this controller: API token and secrets
  2. mkdir ~/panem-workspace && cd ~/panem-workspace && panem workspace init
  3. claude setup-token, then: panem env set CLAUDE_CODE_OAUTH_TOKEN
  4. systemctl --user enable --now panem
MSG
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable --now panem
systemctl --user restart panem
echo "panem is running: systemctl --user status panem"
