# Example workspace repo

Copy this folder into a new **private** git repo and point `panem init --workspace-repo` at it.

```
CLAUDE.md                          -> ~/.claude/CLAUDE.md in every pod
memory/<repo>/                     <-> ~/.claude/projects/-codebase-<repo>/memory/
skills/  plans/  agents/  commands/ -> ~/.claude/<same>
templates/<name>/template.json     repos and default refs
templates/<name>/.devcontainer/    devcontainer.json using the claude-code Feature
.gitattributes                     memory/** merge=union
```

`panem.json` decides what's synced, and from where: this repo, other git repos (e.g. an overlay
repo for codebases that don't commit their CLAUDE.md or spec-kit files), or folders on the
controller. Without it, the layout above is synced as shown. See "Synced files" in the main README.

Memory flows back here when a pod is deleted. The controller merges each file three ways
(your current file, the version the pod started from, and the pod's version) and keeps
lines from both sides. Duplicate lines can accumulate over time; tidy them by hand now and then.
