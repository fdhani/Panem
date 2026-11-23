#!/usr/bin/env bash
# Git credential helper for HTTPS repos: answers `get` with the token Panem stored for that host.
# Tokens live only in ~/.config/panem/git-tokens (0600), one "<host> <username> <token>" per
# line, written by the controller. Nothing is logged; `store` and `erase` are ignored.
# Configured per host: git config --global credential.https://<host>.helper <this script>
set -u
[ "${1:-}" = get ] || exit 0

tokens="$HOME/.config/panem/git-tokens"
protocol="" host=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done
[ "$protocol" = https ] && [ -n "$host" ] && [ -f "$tokens" ] || exit 0

while read -r h user token; do
  if [ "$h" = "$host" ] && [ -n "${token:-}" ]; then
    printf 'username=%s\npassword=%s\n' "$user" "$token"
    exit 0
  fi
done <"$tokens"
exit 0
