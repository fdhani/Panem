# Panem

Agent-ready pods on your own machines, summoned from anywhere.

Panem is a small controller that runs on an always-on Linux box in your Tailscale network. From
its web UI (also usable on a phone) or CLI, you can summon an isolated devcontainer pod on any
of your machines. Each pod boots with:

- your repos at the refs you chose, under `/codebase/<repo>`;
- your CLAUDE.md, memory, skills, and plans;
- a Claude Code Remote Control session, which you open from the Claude app.

When you delete a pod, the memory Claude built inside it is merged back into your workspace repo.
The pod's dev servers are reachable from anywhere on your tailnet, served directly by the machine
the pod runs on.

```
 phone / laptop ──Tailscale──▶ controller (panem serve) ──devpod──▶ machine A: pod, pod
                                   │                       └──────▶ machine B: pod
                                   └── workspace repo (git): templates, CLAUDE.md, memory, skills
 Claude app ◀── Remote Control ── each pod
```

## Concepts

| | |
| --- | --- |
| **Machine** | A Linux or macOS host with Docker, reachable over Tailscale and SSH. It is stored as a DevPod SSH provider named `m-<host>`. |
| **Template** | `templates/<name>/` in the workspace repo: `template.json` (repos and default refs) plus `.devcontainer/devcontainer.json` (which uses the `claude-code` Feature). |
| **Pod** | One template running on one machine at chosen refs. It is a DevPod workspace with the id `<template>-<6 chars>`. |
| **Workspace repo** | Your private git repo. See [`examples/workspace`](examples/workspace) for the layout. |

There is no database:
- DevPod is the source of truth for machines and pods.
- The workspace repo holds templates and context.
- `~/.local/share/panem/` holds a rebuildable pod-metadata cache (`pods.json`) and the export queue (`jobs.json`).

## Setup

On the controller host (Ubuntu) you need `docker`, `git`, `tailscale`, and [DevPod](https://github.com/loft-sh/devpod) v0.6.15. You also need SSH key access from the controller to each machine.

```bash
bun install && bun run build                # -> dist/panem (single binary, UI embedded)
deploy/install.sh                           # ~/.local/bin/panem + systemd user service

claude setup-token                          # long-lived token so pods start logged in
panem init --workspace-repo git@github.com:you/workspace.git --claude-token <token>
systemctl --user enable --now panem
panem token                                 # paste into the web UI's Settings
```

Then:

```bash
panem machine add vps --user dev            # or `local` for the controller's own Docker
panem pod summon example -m vps --ref api=feat/login
panem pod ls
panem pod rm example-ab12cd                 # exports memory, then deletes
```

The UI and API listen only on `127.0.0.1` and the host's Tailscale IP (port 7420). Every API call needs the bearer token.

## How a pod is built

1. The controller pulls the workspace repo and records its commit (`workspaceSha`).
2. It runs `devpod up <workspace repo>@<branch> --devcontainer-path templates/<t>/... --provider m-<host>`. The pod metadata (`PANEM_POD`) and the Claude token are passed through a 0600 env file.
3. The Feature's **postCreateCommand** clones each repo at its ref (only pushed work is reachable) and copies CLAUDE.md, skills, plans, and `memory/<repo>` into `~/.claude`. It also pre-trusts `/codebase/*`, and keeps Panem's own files (pod.json, logs) in `~/.panem/`.
4. The Feature's **postStartCommand** (re)starts `claude remote-control --name <pod id>` in tmux on every start.

## Reaching pod services (ports)

Each machine runs one `panem-forwarder` container, which the controller deploys over SSH. It publishes ports **only on that machine's Tailscale IP**, so traffic goes straight to the machine without passing through the home server.

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

## Memory export

Delete runs as a queued job, one at a time:
1. Start the pod if it is stopped.
2. Pull every `~/.claude/projects/-codebase-<repo>/memory/**` file out of the pod (pods created before the `/codebase` rename use `-workspace-<repo>`, which is still recognised).
3. Merge each file three ways with `git merge-file --union`: the current file, the file at `workspaceSha`, and the pod's file. Lines added on both sides are all kept.
4. Commit, push (retrying on push races), and only then delete the pod.

If the push fails, the pod stays in `error` with a **Retry export** action. If the machine is offline, delete is blocked; **Force delete** discards the memory. `.gitattributes` sets `memory/** merge=union` so edits you push from elsewhere also merge cleanly.

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
| `packages/forwarder` | Per-machine port forwarder (container image) |
| `packages/web` | React SPA (TanStack Router and Query, Tailwind) |
| `packages/cli` | `panem` command (citty); `serve` runs the controller |
| `features/claude-code` | devcontainer Feature: context injection and Remote Control |

## Known gaps and things to verify

- Whether DevPod containers come back after a host reboot (restart policy) is untested. Pods may need `panem pod start` afterwards.
- Remote Control running headless with `CLAUDE_CODE_OAUTH_TOKEN` must be confirmed on a real pod. Its output is logged to `~/.panem/remote-control.log`.
- Cloning private repos inside a pod relies on DevPod forwarding the controller's git credentials during `up`.
- Back up `~/.devpod` on the controller. If it is lost, re-add the machines; pods that DevPod lists again can be re-labelled with `panem rediscover`.
- Using one Claude subscription on several machines at once: check Anthropic's terms.
- **macOS hosts (Docker Desktop):** publishing on the Tailscale IP and reaching pod containers by their Docker IP need a real check.
- **The forwarder mounts the Docker socket,** which is root-equivalent on that machine. It only reads the container list, and joins Docker networks of devcontainer-labelled containers.
