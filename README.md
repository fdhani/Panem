# Panem

Agent-ready pods on your own machines, summoned from anywhere.

Panem is a small controller that runs on an always-on Linux box in your Tailscale network. From
its web UI (also usable on a phone) or CLI, you can summon an isolated devcontainer pod on any
of your machines. Each pod boots with:

- your repos at the refs you chose, under `/codebase/<repo>`;
- your CLAUDE.md, memory, skills, and plans;
- a Claude Code Remote Control session, which you open from the Claude app.

When you delete a pod, the memory Claude built inside it is merged back into your workspace folder.
The pod's dev servers are reachable from anywhere on your tailnet, served directly by the machine
the pod runs on.

```
 phone / laptop ──Tailscale──▶ controller (panem serve) ──devpod──▶ machine A: pod, pod
                                   │                       └──────▶ machine B: pod
                                   └── workspace folder: templates, CLAUDE.md, memory, skills
 Claude app ◀── Remote Control ── each pod
```

## Concepts

| | |
| --- | --- |
| **Machine** | A Linux or macOS host with Docker, reachable over Tailscale and SSH. It is stored as a DevPod SSH provider named `m-<host>`. |
| **Template** | `templates/<name>/` in the workspace folder: `template.json` (repos and default refs, and which credentials its pods get) plus `.devcontainer/devcontainer.json` (which lists one or more agent Features, e.g. `claude-code`). |
| **Pod** | One template running on one machine at chosen refs. It is a DevPod workspace with the id `<template>-<6 chars>`. |
| **Workspace** | A folder on the controller, set up with `panem workspace init`: templates, `panem.json`, CLAUDE.md, skills, and saved memory. See [`examples/workspace`](examples/workspace) for what it starts with. |

There is no database:
- DevPod is the source of truth for machines and pods.
- The workspace folder holds templates and context.
- `~/.local/share/panem/` holds a rebuildable pod-metadata cache (`pods.json`) and the export queue (`jobs.json`).

## Setup

On the controller host (Ubuntu) you need `docker`, `git`, `tailscale`, and [DevPod](https://github.com/loft-sh/devpod) v0.6.15. You also need SSH key access from the controller to each machine.

```bash
bun install && bun run build                # -> dist/panem (single binary, UI embedded)
deploy/install.sh                           # ~/.local/bin/panem + systemd user service

panem init                                  # this controller: API token and secrets
mkdir ~/panem-workspace && cd ~/panem-workspace
panem workspace init                        # this folder is the workspace (adds an example template)
claude setup-token                          # long-lived token so pods start logged in
panem env set CLAUDE_CODE_OAUTH_TOKEN       # paste it at the hidden prompt (or use Settings in the UI)
systemctl --user enable --now panem
panem token                                 # paste into the web UI's Settings
```

Then:

```bash
panem machine add vps --user dev            # or `local` for the controller's own Docker
panem pod summon example -m vps --ref api=feat/login
panem pod ls
panem pod rm example-ab12cd                 # saves memory into the workspace, then deletes
```

The UI and API listen only on `127.0.0.1` and the host's Tailscale IP (port 7420). Every API call needs the bearer token.

## The workspace folder

`panem workspace init` makes a folder the workspace: the current one, or the one you name. It adds what's missing (an example template, `panem.json`, `CLAUDE.md`, and empty `memory/`, `skills/` and `plans/` folders) and never touches files already there. Running it in another folder switches the workspace, and the running controller picks that up without a restart. `panem workspace show` prints the current one.

- **It's uploaded to machines.** DevPod copies the whole folder to a machine for every pod. Keep it to templates and context: it can't be `/` or your home folder, it can't hold Panem's config or data, and `init` warns past 50 MB. Never put secrets in it; use `panem env set`.
- **Backing it up and editing from elsewhere:** the folder lives only on the controller, so back it up. Panem doesn't run git itself, but `panem.json` can give it two commands to run in the folder (see "Workspace hooks" below), for example to pull before each summon and push after each memory save.
- **Moving from a workspace repo:** configs from before this still point at a git URL, and `panem serve` stops with these steps: `git clone <url> ~/panem-workspace`, then `cd ~/panem-workspace && panem workspace init`. Templates, `panem.json` and `memory/` carry over as they are.

### Workspace hooks

```json
{
  "sync": [{ "preset": "claude-code" }],
  "hooks": {
    "beforeSummon": "git pull --ff-only -q",
    "afterMemorySave": "git add -A memory && git commit -qm \"panem: memory from $PANEM_POD_ID\" && git push -q"
  }
}
```

With the folder as a git repo (`git init`, add a remote, push once), templates you push from your laptop are pulled before each summon, and every memory save is committed and pushed. Any command works, e.g. `rclone sync . r2:panem-workspace` instead of git.

- **`beforeSummon`** runs at the start of each summon, before templates are read, so a change you just pushed applies to that summon. It gets `PANEM_TEMPLATE`.
- **`afterMemorySave`** runs right after a pod's memory was merged into the folder, and only if files changed. It gets `PANEM_POD_ID`, and `PANEM_SAVED_FILES`: the changed paths, one per line.
- Both run on the controller with bash, in the workspace folder, as the controller's user, one at a time (never alongside a memory save). Each gets 2 minutes. Credentials from `panem env` aren't passed to them.
- **A failing hook never blocks anything.** A failed pull means the summon uses the folder as it is. A failed push means the memory is still safe in the folder, and the next save pushes it. Failures go to the controller log with their last lines of output.
- They're read from the folder's current `panem.json` each time. A misspelt hook name shows as a template error.

### Panem's Features

Templates list Panem's devcontainer Features by a local path, e.g. `"./panem-features/claude-code"`. At every summon Panem writes them next to the template's `devcontainer.json`, in `panem-features/` (always the running version, with a `.gitignore` so a git-backed workspace stays clean), and DevPod uploads them with the workspace. Nothing has to be published to a registry. A template still listing `ghcr.io/fdhani/panem/claude-code:0` gets a warning on the Summon page: change it to the local path.

## How a pod is built

1. The controller reads the template from the workspace folder, resolves the pod's sync rules from `panem.json` (see below), and saves them with the pod.
2. It runs `devpod up <workspace folder> --devcontainer-path templates/<t>/... --provider m-<host>`. DevPod uploads the folder to the machine and builds the pod from the template's devcontainer. The pod metadata (`PANEM_POD`), the credentials the template lists and the relay secret are passed through a 0600 env file.
3. **One-time setup** (the Feature's `post-create.sh`): clones each code repo at its ref into `/codebase/<repo>` (only pushed work is reachable), pre-trusts `/codebase/*`, and keeps Panem's own files (pod.json, logs) in `~/.panem/`.
4. **Copy-in:** the controller copies the synced files in (CLAUDE.md, skills, memory, overlays, whatever the rules say). It keeps a copy of the memory it sent, under `~/.local/share/panem/pods/<id>/memory-base/`, to merge against when the pod is deleted.
5. **Start hook** (`post-start.sh`): starts the port relay and `claude remote-control --name <pod id>` in tmux. It also runs on every later start.

Panem starts nothing else. Templates shouldn't start databases or backends in `postStartCommand` either, since pods would then run them all the time. The agent starts them when a task needs them; the scaffolded `CLAUDE.md` tells it how ("Services"). If your templates do start services, drop that line. Ports a service opens appear on the pod card as usual, closed until you switch them on.

Inside the pod: your code is in `/codebase/<repo>`; Panem's files are in `~/.panem/`; DevPod's own copy of the workspace folder is in `/workspaces/<pod-id>/`, and Panem doesn't use it.

## Private repos

Panem gives each pod exactly the git access its template's repos need, and checks it works before building anything. A summon either clones every repo, or is refused straight away with one line per repo saying what's wrong: no host key, no credentials, no access, or no such branch. The Summon page runs the same check when you pick a template.

**SSH repos** (`git@host:path`, `ssh://…`): nothing to add to templates. Set up the controller so that its own `git clone` of each repo works, as the user Panem runs as:
1. **A key per host in `~/.ssh/config`**, e.g. `Host gitlab.com` with `IdentityFile ~/.ssh/gitlab_deploy`. Aliases work too: `git@gitlab-work:team/x.git` with `Host gitlab-work` and `HostName gitlab.com`. Keys must have no passphrase, since Panem can't type one. A read-only deploy key is ideal.
2. **The host's key in `~/.ssh/known_hosts`:** run `ssh -T git@gitlab.com` once and check the fingerprint against the one the host publishes. Panem never fetches host keys blindly.

At each summon Panem starts a short-lived ssh-agent of its own, loaded with **only the keys for that template's hosts**, and forwards it into the pod's setup session (the clone). It's gone once setup ends. Before-destroy hooks get the same for their run. Pods never receive key files, and the agent in the pod has no SSH access after setup.

**HTTPS repos with a token** (`https://…`): add the token as a credential (`panem env set GITLAB_TOKEN`, or Settings → Agent credentials) and name it in the template:
```json
"git": { "gitlab.com": { "token": "GITLAB_TOKEN" } }
```
`username` is optional (default `x-access-token` for github.com, `oauth2` otherwise). The pod gets the token only in `~/.config/panem/git-tokens` (0600), read by Panem's git credential helper for that host. It isn't in the clone URL, git config, the pod's environment or any log, even if the template's `env` also lists it. The helper stays in the pod, so **this is how the agent in a pod can push**: use a token scoped to what it should do, read-only unless it should push.

**DevPod settings Panem changes:** at startup, `panem serve` sets `SSH_ADD_PRIVATE_KEYS=false` and `SSH_INJECT_GIT_CREDENTIALS=false` on DevPod's context, and its own `devpod ssh` calls pass `--start-services=false`. Otherwise DevPod would load every key in `~/.ssh` into any forwarded agent, and forward the controller's whole git credential store to pods. These settings also apply to other DevPod use by the same user.

## Reaching pod services (ports)

Each machine runs one `panem-forwarder` container, which the controller deploys over SSH. It publishes ports **only on that machine's Tailscale IP**, so traffic goes straight to the machine without passing through the home server.

Nothing is downloaded from Panem: like DevPod injecting its own agent, the controller copies the forwarder's code (one ~75 KB JS file, to `~/.panem-forwarder/` on the machine) and runs it with the official `oven/bun` image from Docker Hub, the same Bun version Panem is built with. A new Panem version (or changed code) redeploys it. Set `forwarder.image` in the config to run a prebuilt image instead.

```
phone ──tailnet──▶ vps:7601 ──▶ panem-forwarder ──docker network──▶ relay in pod :7699 ──▶ localhost:5173
```

- **Blocks:** each pod gets a block of 10 host ports from 7600–7699 on its machine. Slot 0 (e.g. `vps:7600`) is an index page of the pod's published services. Slots 1–9 are for ports you switch on.
- **Off by default:** every port listening in the pod is listed on its card, including servers bound to `localhost`, but each stays closed until you switch it on.
  - A switched-on port keeps its host port across stop and start, until you switch it off or delete the pod.
  - The "Expose another port" field switches on a port that isn't listening yet.
  - From the CLI: `panem pod expose <id> <port>` and `panem pod unexpose <id> <port>`.
- **Templates:** ports a template names start switched on, and `ignorePorts` hides ports entirely:
  ```json
  { "ports": { "5173": "web", "8000": "api" }, "ignorePorts": [9229] }
  ```
- **Where the switches live:** in the controller's pod metadata. They're pushed to the forwarder when you flip one, and re-synced on every poll, so a redeployed forwarder comes back with the same ports open.
- **How it works:**
  1. Inside the pod, a small relay (socat on port 7699, never published) answers the forwarder with the pod's listening ports and pipes connections to them.
  2. The forwarder on each machine polls those relays every 3 seconds.
  3. The controller reads each forwarder's table (`GET /state`) every 5 seconds.
- **Secrets:** a shared relay secret and a forwarder token live in the controller config. `panem serve` adds them to older configs automatically.
- **Repair:** `panem machine repair <name>` (or **Repair** in the UI) redeploys a forwarder. Outdated or unresponsive forwarders are also redeployed automatically.
- **Who can reach the services:** anyone on your tailnet, without the API token. Use Tailscale ACLs to narrow that if needed.

## Agents

Panem itself is agent-agnostic. Agents are devcontainer Features that a template lists. Claude Code (`claude-code`, reached through Remote Control in the Claude app) is the one that ships today, and a template can list several.
- **The pod card** shows each agent's connect buttons, read from the pod's `~/.panem/agents.json`.
- **Writing an agent:** see `features/README.md`.

**Credentials:**
- The controller holds them by environment variable name. Set them with `panem env set NAME`: the value is read from stdin or a hidden prompt, never from the command line. `panem env ls` lists names only; `panem env rm NAME` removes one.
- Or use **Settings → Agent credentials** in the web UI: it lists every credential your templates ask for, marks missing ones, and lets you set, replace or remove them (tap a row), with when each was last updated. Values are write-only there too: the UI and API never show them. The Summon page warns when the chosen template needs one that isn't set.
- Each template lists the ones its pods get, so a pod never sees credentials it doesn't need:
  ```json
  { "repos": [ ... ], "env": ["CLAUDE_CODE_OAUTH_TOKEN"] }
  ```
- A template without `env` gets just `CLAUDE_CODE_OAUTH_TOKEN`, as before.
- `panem init --claude-token` still sets that one, but it's deprecated: it leaves the token in your shell history.
- `panem init --force` starts over: a new API token and secrets, and all credentials removed. To change one credential, use `panem env set`.
- Changes apply to the next summon, with no restart.

**Sync presets:** `{ "preset": "claude-code" }` in a `sync` list stands for Claude Code's files (CLAUDE.md, skills, plans, agents and commands into `~/.claude/`, plus per-repo memory both ways). It's also the default.

## Synced files (`panem.json`)

`panem.json` at the root of the workspace folder decides which files are copied into a pod when it's created. **Sync is copy-in only.** The one exception is agent memory, which is saved back on delete.

Without the file, the defaults apply (`[{ "preset": "claude-code" }]`), which are what Panem always did:
- `CLAUDE.md`, `skills/`, `plans/`, `agents/` and `commands/` are copied into `~/.claude/`.
- `memory/<repo>/` is copied into Claude's memory folder for that repo, and saved back on delete.

```json
{
  "sources": {
    "overlay": { "git": "git@github.com:you/claude-overlay.git", "ref": "main" },
    "local":   { "dir": "~/claude-context" }
  },
  "sync": [
    { "preset": "claude-code" },
    { "source": "overlay", "from": "{repo}/**", "to": "/codebase/{repo}/**" },
    { "source": "local", "from": "skills/**", "to": "~/.claude/skills/**" }
  ],
  "exclude": ["**/.DS_Store"]
}
```

**Sources** are where files come from:
- **The workspace folder:** any rule without `source`.
- **Other git repos** (`git` + `ref`): the controller clones and pulls them itself. An empty repo is fine.
- **Folders on the controller host** (`dir`).

**Rules:**
- `from` is a path in the source, `to` a path in the pod. Each is either one file, or a folder ending in `/**` whose contents are carried over.
- `{repo}` repeats the rule for each of the pod's repos.
- `include` narrows a folder rule (e.g. `"**/*.md"`). `exclude`, global or per rule, drops files; both are globs (`**`, `*`, `?`).
- `{ "preset": "<agent>" }` stands for an agent's rules, including its memory.
- A template's own `sync` (in `template.json`) replaces the list for its pods, and its `syncExclude` adds excludes.
- Rules have no `flow` or `merge`. Writing either is an error that explains copy-in only.

**Where files can go in the pod:**
- **`~/...`** is your personal setup.
- **`/codebase/{repo}/...`** is an **overlay** for files a codebase doesn't commit, such as a CLAUDE.md or spec-kit files. Overlays never overwrite files the repo tracks (the committed version wins, and a note is logged). They're added to the repo's `.git/info/exclude`, so `git status` stays clean and they can't be committed by accident.

**Checked when the rules load** (a bad rule shows as a template error and blocks summon):
- No `..` and nothing inside `.git`.
- Nothing may write into `~/.panem` or `~/.config/panem`.

**On delete**, agent memory is saved, one pod at a time:
1. Start the pod if it's stopped.
2. Collect the agent's memory folders, within a limit of 50 MB packed and 5,000 files.
3. Merge each file into the workspace folder three ways, against the copy the pod was given, keeping every line either side added. Edits made in the folder while the pod ran are kept. A binary file is taken only if the folder's copy didn't change. Deletions never propagate.
4. Only then is the pod deleted. Panem never commits: if the folder is a git repo, commit and push it yourself (see "The workspace folder").

If saving fails, the pod stays in `error` with **Retry**. Saving always uses the rules the pod was created with, even if `panem.json` changed since. Pods from before this export memory with the defaults, including pre-rename `-workspace-<repo>` folders. Pods from when the workspace was a git repo have no saved copy to merge against, so both sides' lines are kept.

Nothing else comes back. Work worth keeping in an overlay (e.g. new specs) is pushed by the pod itself, from a before-destroy hook (see below), or committed to the code repo.

## Before-destroy hooks

Work other than agent memory that should outlive a pod is pushed **by the pod itself**, straight to where it belongs, just before the pod is deleted. Panem never merges it.

- **Template:** `template.json` → `"hooks": { "beforeDestroy": "<command>" }`. It runs in the pod with bash, from `/codebase`, as the pod user.
- **Agents:** an agent Feature can ship `before-destroy.sh` (see `features/README.md`).

**Order on delete:**
1. Agent hooks, in name order.
2. The template's hook.
3. Agent memory is saved, unless you chose **Delete without saving memory** (`panem pod rm --no-memory`).
4. The pod is deleted.

Hooks run on every delete; there's nothing to confirm. Only **Force delete** (`panem pod rm --force`) skips them, along with the memory save. It's for when hooks can't run: the machine is offline, or a hook keeps failing.

**How hooks run:**
- Each hook gets 10 minutes. Full output goes to `~/.panem/before-destroy.log` in the pod.
- They run over `devpod ssh`, so the controller's git credentials are forwarded, the same way code repos are cloned at setup.
- A failing hook keeps the pod and shows its last output lines on the card. **Retry** runs the hooks (and the memory save, if chosen) again, so hooks should be idempotent (`git commit` + `git push` naturally is). **Force delete** skips them.
- The hook a pod runs is the one its template had at summon.

**Example: push overlay work (e.g. new spec-kit specs) back to an overlay repo.** Panem records the files it overlaid in `~/.panem/overlays/<repo>.list`.

```json
"hooks": {
  "beforeDestroy": "bash ~/push-overlay.sh git@github.com:you/claude-overlay.git api specs"
}
```

The script itself can be synced into the pod like any other file, e.g. `{ "source": "overlay", "from": "push-overlay.sh", "to": "~/push-overlay.sh" }`.

```bash
#!/usr/bin/env bash
# push-overlay.sh <overlay repo url> <code repo> [folder...]: copy this repo's overlay files,
# plus new untracked files (not gitignored) in the overlay's folders and the folders given
# (e.g. specs), back into the overlay repo, then push.
set -euo pipefail
url="$1" repo="$2"
shift 2
src="/codebase/$repo" list="$HOME/.panem/overlays/$repo.list" work="$(mktemp -d)"
git clone --quiet "$url" "$work"
mapfile -t dirs < <({ cut -d/ -f1 "$list"; printf '%s\n' "$@"; } | sort -u)
mapfile -t files < <({
  cat "$list"
  (cd "$src" && git ls-files --others --exclude-standard -- "${dirs[@]}")
} | sort -u)
for f in "${files[@]}"; do
  [ -f "$src/$f" ] || continue
  mkdir -p "$work/$repo/$(dirname "$f")"
  cp "$src/$f" "$work/$repo/$f"
done
cd "$work"
git add -A
git diff --cached --quiet || git commit -qm "overlay: save $repo from $(hostname)"
git pull --quiet --rebase && git push --quiet
```

## Development

```bash
bun test                                   # unit + fake-devpod + git-backed export + API tests
bun run lint && bun run typecheck
PANEM_BACKEND=mock PANEM_CONFIG=... bun packages/cli/src/main.ts serve   # in-memory backend
bun run --cwd packages/web dev             # Vite dev server, proxies /api to :7420
DEVPOD=devpod bun scripts/integration.ts   # real DevPod + Docker end to end (also in CI)
```

| Package | |
| --- | --- |
| `packages/core` | zod schemas, the `PodBackend` interface, naming, config |
| `packages/backend-devpod` | `PodBackend` on the DevPod CLI (`Bun.spawn`, pinned version) |
| `packages/controller` | Hono API + SSE, pod service, export worker, forwarder management, mock backend |
| `packages/forwarder` | Per-machine port forwarder (one JS file, run with the official Bun image) |
| `packages/web` | React SPA (TanStack Router and Query, Tailwind) |
| `packages/cli` | `panem` command (citty); `serve` runs the controller |
| `features/src/panem` | devcontainer Feature: the agent-agnostic pod base (repos, relay, agent hooks) |
| `features/src/claude-code` | devcontainer Feature: the Claude Code agent (Remote Control) |

## Known gaps and things to verify

- Whether DevPod containers come back after a host reboot (restart policy) is untested. Pods may need `panem pod start` afterwards.
- Copy-in uses stdin through `devpod ssh`, and falls back to sending base64 in chunks if stdin doesn't arrive. CI's integration test reports which path DevPod used. The in-pod scripts need GNU `tar` (Debian and Ubuntu images have it; busybox tar on Alpine doesn't support every flag they use).
- Pods built from a Feature release before 0.3.0 still copy the default context during setup. That's harmless, but default paths a `panem.json` excludes will still appear on those pods.
- Remote Control running headless with `CLAUDE_CODE_OAUTH_TOKEN` must be confirmed on a real pod. Its output is logged to `~/.panem/remote-control.log`.
- **SSH git access exists only during setup and before-destroy hooks.** The agent in a pod can't `git push` over SSH. Give repos it should push to an `https://` URL and a token.
- SSH keys with a passphrase can't be used: Panem can't unlock them unattended.
- Forwarding Panem's scoped agent into `devpod ssh` with `--start-services=false` is tested with a fake DevPod. Check it on a real pod with a private repo.
- Back up `~/.devpod` on the controller. If it is lost, re-add the machines; pods that DevPod lists again can be re-labelled with `panem rediscover`.
- Using one Claude subscription on several machines at once: check Anthropic's terms.
- **macOS hosts (Docker Desktop):** publishing on the Tailscale IP and reaching pod containers by their Docker IP need a real check.
- **The forwarder mounts the Docker socket,** which is root-equivalent on that machine. It only reads the container list, and joins Docker networks of devcontainer-labelled containers.
