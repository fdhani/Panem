#!/usr/bin/env bash
# Runs inside a pod, sent by the controller when it saves agent memory on delete. Prints
# $HOME, then the code root, each on its own line, then a base64 tar.gz of the files with
# absolute paths (base64 because the SSH transport may not be binary-safe).
#
# Usage: export.sh MAX_BYTES MAX_FILES ROOT...
#   ROOT is "h:<path under $HOME>" (an agent's memory folder).
set -euo pipefail
max_bytes="$1"
max_files="$2"
shift 2
code="${PANEM_CODE_ROOT:-/codebase}"
l="$(mktemp)"
t="$(mktemp)"
trap 'rm -f "$l" "$t"' EXIT

add_tree() { # file or folder
  if [ -f "$1" ]; then
    printf '%s\0' "$1" >>"$l"
  elif [ -d "$1" ]; then
    find "$1" -type f -not -path '*/.git/*' -print0 >>"$l"
  fi
}

for r in "$@"; do
  case "$r" in
  h:*)
    add_tree "$HOME/${r#h:}"
    ;;
  esac
done

n="$(tr -cd '\0' <"$l" | wc -c | tr -d ' ')"
if [ "$n" -gt "$max_files" ]; then
  echo "panem: export has $n files, over the limit of $max_files" >&2
  exit 98
fi
tar --null -czf "$t" -P -T "$l"
size="$(wc -c <"$t" | tr -d ' ')"
if [ "$size" -gt "$max_bytes" ]; then
  echo "panem: export is $size bytes packed, over the limit of $max_bytes" >&2
  exit 98
fi
printf '%s\n%s\n' "$HOME" "$code"
base64 "$t" | tr -d '\n'
