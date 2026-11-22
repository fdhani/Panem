# Panem workspace

This folder is the workspace of a Panem controller (set with `panem workspace init`).
When you summon a pod, DevPod uploads this folder to the machine and builds the pod from the
template's devcontainer, so keep it small and never put secrets in it (use `panem env set`).

```
templates/<name>/template.json     repos, default refs, ports, credentials ("env")
templates/<name>/.devcontainer/    devcontainer.json using the claude-code Feature
panem.json                         which files are copied into pods, and from where
CLAUDE.md                          -> ~/.claude/CLAUDE.md in every pod
skills/  plans/  agents/  commands/ -> ~/.claude/<same>
memory/<repo>/                     <-> ~/.claude/projects/-codebase-<repo>/memory/
```

Files are copied into a pod when it's created; only agent memory comes back, when the pod is
deleted. It's merged with this folder line by line, so edits made here meanwhile are kept.
Duplicate lines can build up over time: tidy them now and then.

This folder lives only on the controller, so back it up. Panem never runs git itself, but
panem.json can give it commands to run here, e.g. with this folder as a git repo:

  "hooks": {
    "beforeSummon": "git pull --ff-only -q",
    "afterMemorySave": "git add -A memory && git commit -qm \"panem: memory from $PANEM_POD_ID\" && git push -q"
  }

See "Workspace hooks" in Panem's README.
