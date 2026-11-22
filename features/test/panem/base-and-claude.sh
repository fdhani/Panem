#!/usr/bin/env bash
# Scenario "base-and-claude": the base listed explicitly plus an agent; the agent registers
# itself next to the base.
set -e
# shellcheck disable=SC1091
source dev-container-features-test-lib
check "base installed" test -x /usr/local/share/panem/post-create.sh
check "agent registered" test -f /usr/local/share/panem/agents/claude-code/agent.json
reportResults
