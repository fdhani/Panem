#!/usr/bin/env bash
# Runs inside a pod, sent by the controller (not part of the Feature, so sync rules never need
# a Feature release). Reads a tar.gz on stdin laid out by destination:
#   home/<path>              -> $HOME/<path>
#   codebase/<repo>/<path>   -> $PANEM_CODE_ROOT/<repo>/<path>  (a repo overlay)
# Overlay files are never written over files the repo tracks, are listed in the repo's
# .git/info/exclude (local only) so they can't be committed by accident, and are recorded in
# ~/.panem/overlays/<repo>.list so export can find them again.
set -euo pipefail
code="${PANEM_CODE_ROOT:-/codebase}"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
tar -xzf - -C "$t"

if [ -d "$t/home" ]; then
  (cd "$t/home" && tar -cf - .) | (cd "$HOME" && tar -xf -)
fi

if [ -d "$t/codebase" ]; then
  for src in "$t"/codebase/*/; do
    repo="$(basename "$src")"
    dest="$code/$repo"
    if [ ! -d "$dest" ]; then
      echo "panem: overlay for $repo skipped: $dest does not exist" >&2
      continue
    fi
    list="$HOME/.panem/overlays/$repo.list"
    mkdir -p "$(dirname "$list")"
    touch "$list"
    while IFS= read -r -d '' f; do
      rel="${f#./}"
      if git -C "$dest" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
        echo "panem: overlay skipped $repo/$rel: the repo tracks it" >&2
        continue
      fi
      mkdir -p "$dest/$(dirname "$rel")"
      cp "$src/$rel" "$dest/$rel"
      grep -qxF -- "$rel" "$list" || printf '%s\n' "$rel" >>"$list"
      if [ -d "$dest/.git" ]; then
        mkdir -p "$dest/.git/info"
        # Anchored, with gitignore's special characters escaped.
        pat="/$(printf '%s' "$rel" | sed 's/[][*?!#\\]/\\&/g')"
        grep -qxF -- "$pat" "$dest/.git/info/exclude" 2>/dev/null ||
          printf '%s\n' "$pat" >>"$dest/.git/info/exclude"
      fi
    done < <(cd "$src" && find . -type f -print0)
  done
fi
