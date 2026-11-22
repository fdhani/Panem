#!/usr/bin/env bash
# Scenario "base-only": a pod with no agent at all.
set -e
# shellcheck disable=SC1091
source dev-container-features-test-lib
check "hooks installed" test -x /usr/local/share/panem/post-start.sh
# shellcheck disable=SC2016 # expands inside bash -c, on purpose
check "agents folder empty" bash -c '[ -z "$(ls -A /usr/local/share/panem/agents)" ]'
check "code root writable" test -w /codebase
check "socat" command -v socat
reportResults
