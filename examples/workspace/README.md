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

Memory flows back here when a pod is deleted. The controller merges each file three ways
(your current file, the version the pod started from, and the pod's version) and keeps
lines from both sides. Duplicate lines can accumulate over time; tidy them by hand now and then.
