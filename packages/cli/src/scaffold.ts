/**
 * What `panem workspace init` writes into a new workspace folder (only files that are missing).
 * examples/workspace in the repo is the same set of files; a test keeps them equal.
 */
export const SCAFFOLD: Record<string, string> = {
  "README.md": `# Panem workspace

This folder is the workspace of a Panem controller (set with \`panem workspace init\`).
When you summon a pod, DevPod uploads this folder to the machine and builds the pod from the
template's devcontainer, so keep it small and never put secrets in it (use \`panem env set\`).

\`\`\`
templates/<name>/template.json     repos, default refs, ports, credentials ("env")
templates/<name>/.devcontainer/    devcontainer.json using the claude-code Feature
panem.json                         which files are copied into pods, and from where
CLAUDE.md                          -> ~/.claude/CLAUDE.md in every pod
skills/  plans/  agents/  commands/ -> ~/.claude/<same>
memory/<repo>/                     <-> ~/.claude/projects/-codebase-<repo>/memory/
\`\`\`

Files are copied into a pod when it's created; only agent memory comes back, when the pod is
deleted. It's merged with this folder line by line, so edits made here meanwhile are kept.
Duplicate lines can build up over time: tidy them now and then.

Want history, or to edit from your laptop? Make this folder a git repo and push it somewhere.
Panem only reads and writes files here; it never commits.
`,
  "CLAUDE.md": `# Global instructions

Repos live under /codebase/<repo>. Commit and push work you want to keep: pods are disposable,
and only pushed refs can be summoned into another pod.
`,
  "panem.json": `{
  "sources": {},
  "sync": [{ "preset": "claude-code" }],
  "exclude": ["**/.DS_Store"]
}
`,
  "templates/example/template.json": `{
  "description": "Frontend + API (edit the repos to yours)",
  "ports": { "5173": "web", "8000": "api" },
  "ignorePorts": [9229],
  "repos": [
    { "name": "api", "url": "git@github.com:you/api.git", "ref": "main", "primary": true },
    { "name": "web", "url": "git@github.com:you/web.git", "ref": "main" }
  ],
  "env": ["CLAUDE_CODE_OAUTH_TOKEN"]
}
`,
  "templates/example/.devcontainer/devcontainer.json": `{
  "name": "example",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "remoteUser": "vscode",
  "features": {
    "ghcr.io/devcontainers/features/node:1": {},
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    "ghcr.io/fdhani/panem/claude-code:0": { "permissionMode": "acceptEdits" }
  },
  // Dev servers: runs on every start, after the Feature's Remote Control hook.
  "postStartCommand": "cd /codebase/api && (docker compose up -d || true)"
}
`,
  "memory/.gitkeep": "",
  "skills/.gitkeep": "",
  "plans/.gitkeep": "",
};

/** A workspace bigger than this is probably the wrong folder: warn (it's uploaded per pod). */
export const WORKSPACE_WARN_BYTES = 50 * 1024 * 1024;
