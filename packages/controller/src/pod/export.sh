#!/usr/bin/env bash
# Runs inside a pod, sent by the controller. Collects the files that sync rules write back
# and prints:  $HOME, then the code root, each on its own line, then a base64 tar.gz of the
# files with absolute paths (base64 because the SSH transport may not be binary-safe).
#
# Usage: export.sh MAX_BYTES MAX_FILES ROOT...
#   ROOT is "h:<path under $HOME>" or "c:<repo>[/<path>]" (under the code root).
# Overlay roots collect untracked files that aren't gitignored (so not node_modules), plus
# the files Panem overlaid there (hidden by .git/info/exclude), but never tracked files.
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
  c:*)
    rel="${r#c:}"
    repo="${rel%%/*}"
    sub=""
    [ "$rel" = "$repo" ] || sub="${rel#"$repo"/}"
    dir="$code/$repo"
    [ -d "$dir" ] || continue
    if [ ! -d "$dir/.git" ]; then
      add_tree "$dir${sub:+/$sub}"
      continue
    fi
    (cd "$dir" && git ls-files -z --others --exclude-standard -- "${sub:-.}") |
      while IFS= read -r -d '' f; do printf '%s\0' "$dir/$f"; done >>"$l"
    list="$HOME/.panem/overlays/$repo.list"
    if [ -f "$list" ]; then
      while IFS= read -r f; do
        case "$f" in "$sub" | "$sub"/*) ;; *) [ -z "$sub" ] || continue ;; esac
        [ -f "$dir/$f" ] || continue
        git -C "$dir" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && continue
        printf '%s\0' "$dir/$f"
      done <"$list" >>"$l"
    fi
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
