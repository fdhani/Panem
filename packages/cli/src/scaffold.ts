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

Templates shouldn't start databases or backends (no \`postStartCommand\` for that): pods would
run them all the time. The agent starts what a task needs, guided by the "Services" section in
CLAUDE.md.

This folder lives only on the controller, so back it up. Panem never runs git itself, but
panem.json can give it commands to run here, e.g. with this folder as a git repo:

  "hooks": {
    "beforeSummon": "git pull --ff-only -q",
    "afterMemorySave": "git add -A memory && git commit -qm \\"panem: memory from $PANEM_POD_ID\\" && git push -q"
  }

See "Workspace hooks" in Panem's README.
`,
  "CLAUDE.md": `# Global instructions

Repos live under /codebase/<repo>. Commit and push work you want to keep: pods are disposable,
and only pushed refs can be summoned into another pod.

## Services

Databases, backend services and other dev services are not running when the pod starts.
Start only what the current task needs, when it needs it (for example \`docker compose up -d db\`
in the repo), and stop it when you're done (\`docker compose stop\`). Don't give containers a
restart policy (\`restart: always\` or \`unless-stopped\`): they'd come back on every pod start.
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
  // Pinned: the plain "ubuntu" tag now means Ubuntu 26.04, where docker-in-docker's default
  // moby: true fails (no moby packages for that release).
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "remoteUser": "vscode",
  "features": {
    "ghcr.io/devcontainers/features/node:1": {},
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    // Panem's own Feature: Panem puts it in panem-features/ at each summon (no registry).
    "./panem-features/claude-code": { "permissionMode": "acceptEdits" }
  }
  // No postStartCommand starting services (databases, backends): they'd run on every pod
  // start. The agent starts what a task needs, when it needs it (see CLAUDE.md).
}
`,
  "memory/.gitkeep": "",
  "skills/.gitkeep": "",
  "plans/.gitkeep": "",
};

/** A workspace bigger than this is probably the wrong folder: warn (it's uploaded per pod). */
export const WORKSPACE_WARN_BYTES = 50 * 1024 * 1024;
