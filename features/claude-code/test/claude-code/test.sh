#!/usr/bin/env bash
# Run with: devcontainer features test -f claude-code --base-image mcr.microsoft.com/devcontainers/base:ubuntu
set -e
# shellcheck disable=SC1091
source dev-container-features-test-lib
check "scripts installed" test -x /usr/local/share/panem/post-create.sh
check "workspace root" test -d /workspace
check "tmux" command -v tmux
check "jq" command -v jq
check "claude" bash -lc 'command -v claude || test -x "$HOME/.local/bin/claude"'
reportResults
