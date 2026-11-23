# Panem devcontainer Features

Two kinds of Feature make a container a Panem pod:

| Feature | What it is |
| --- | --- |
| `panem` (`src/panem`) | **The pod base**, agent-agnostic. Clones the pod's repos into `/codebase`, keeps Panem's files in `~/.panem`, runs the port relay, and runs the hooks of every agent installed next to it. |
| `claude-code` (`src/claude-code`) | **An agent:** Claude Code with Remote Control. Brings the base along if a template doesn't list it. |

A template lists one or more agents. Listing `panem` too is optional. Panem writes its Features next to each template's `devcontainer.json`, in `panem-features/`, at every summon (always the running Panem's version), so templates reference them locally and nothing has to be published:

```jsonc
"features": {
  "./panem-features/claude-code": {
    "installClaude": true,      // native installer
    "remoteControl": true,      // run `claude remote-control` in tmux on every start
    "permissionMode": "default" // for Remote Control sessions
  }
}
```

## The base (`panem`)

| Hook | Script | What it does |
| --- | --- | --- |
| install | `install.sh` | git, tmux, jq, curl, socat; `/codebase` (sticky, world-writable); scripts in `/usr/local/share/panem/` |
| postCreateCommand | `post-create.sh` | Applies the git access the controller placed in `~/.panem/git/` (host keys into `~/.ssh/known_hosts`, an `Include` of the alias config at the top of `~/.ssh/config`, and `git-credential-panem.sh` as the credential helper for HTTPS token hosts). Then clones `PANEM_POD.repos` into `/codebase/<repo>` at their refs; writes `~/.panem/pod.json`; saves the credentials named in `PANEM_AGENT_ENV`, plus the relay secret, to `~/.config/panem/env` (0600); runs every agent's `setup.sh`; writes `~/.panem/agents.json` |
| postStartCommand | `post-start.sh` | Starts the port relay (tmux `panem-relay`), then every agent's `start.sh`. One agent failing doesn't stop the others. |

The base doesn't copy CLAUDE.md, skills or memory. The controller copies synced files in, following the workspace folder's `panem.json`, between `post-create` and `post-start`.

DevPod (v0.6.x) doesn't run lifecycle hooks declared by Features, so Panem runs them itself over `devpod ssh`:
- after `up`: `post-create.sh` once, then the controller's copy-in, then `post-start.sh`;
- after each start: `post-start.sh`.

Both are idempotent.

**`panemBuild` option:** set by the controller at each summon (a hash of the Features' files) and recorded in `/usr/local/share/panem/BUILD`. DevPod's image cache key includes Feature options, so a changed hash builds a new image. Setup refuses to run when the recorded build doesn't match the controller's (`PANEM_EXPECT_BUILD`). Leave it unset in templates.

**Clone errors:** a failed clone stops setup with one line, `panem: clone of <repo> (<url>) at <ref> failed: <git's message>`, which the controller shows as the pod's error. Clones never prompt (`GIT_TERMINAL_PROMPT=0`).

**Git token helper** (`git-credential-panem.sh`): answers `get` for the HTTPS hosts listed in `~/.config/panem/git-tokens` (0600, `<host> <username> <token>`), and nothing else. It's the only place a git token lives in a pod.

**Port relay:** `socat` on container port 7699, never published. The machine's `panem-forwarder` sends one line, `<secret> <cmd>`:
- `list`: the ports listening right now;
- `meta`: `pod.json`;
- a port number: pipes the connection to that port on the pod's loopback (IPv4, or `::1`).

**Inputs** (set by the controller):
- `PANEM_POD`: the pod's metadata as JSON.
- `PANEM_AGENT_ENV`: comma-separated names of the credentials the template opted in to.
- Those credentials themselves.
- `PANEM_RELAY_SECRET`.

**Overrides** (normally left alone):
- `PANEM_CODE_ROOT`: default `/codebase`. The old name `PANEM_WORKSPACE_ROOT` still works.
- `PANEM_STATE_DIR`: default `~/.panem`.

## Writing an agent Feature

An agent Feature installs a folder `/usr/local/share/panem/agents/<id>/` containing:

| File | Required | What it is |
| --- | --- | --- |
| `agent.json` | yes | `{ "id": "<id>", "label": "Name", "connect": [{ "label": "Open in …", "url": "https://…" }], "login": { … } }`. The pod card shows one button per `connect` entry. `log` (optional, `~/…`) is the agent's own log: its page in the web UI shows the last 1,000 lines as they are. `login` is optional (below). |
| `setup.sh` | no | Runs once after the repos are cloned, e.g. trust settings. Failing fails pod setup. |
| `start.sh` | no | Runs on every start, e.g. a remote-access session in tmux. Failing is logged. |
| `before-destroy.sh` | no | Runs before the pod is deleted (from `/codebase`), before the template's own hook and before agent memory is saved, e.g. to push the agent's state somewhere. Runs on every delete except a force delete. Failing keeps the pod. The controller runs it, so it works with any version of the base. |

Hooks run as the pod user. They can `. "$(dirname "$0")/../../lib.sh"` for the base's helpers:
- `pod_json`, `primary_repo_dir`, `log`;
- `agent_status <running|needs-login|stopped|error> [message]`: what the pod card shows for the agent (written to `~/.panem/agents/<id>.status.json`). Call it from `start.sh`;
- `$PANEM_CODE_ROOT`, `$PANEM_STATE_DIR`;
- saved credentials, restored on every start.

**Signing in (`agent.json` `login`):**
```json
"login": {
  "label": "Sign in to Claude",
  "command": "env -u CLAUDE_CODE_OAUTH_TOKEN claude auth login",
  "share": [".claude/.credentials.json"]
}
```
- `command` is the agent's own interactive sign-in. The web UI's **Sign in** (a machine's page, or the agent's page in a pod) runs it in a terminal in the browser; `panem agent-login <machine> [agent]` (or `--pod <pod>`) runs it in the user's own terminal, and `panem agent-login` alone lists the agents with a sign-in on each machine (every agent Panem ships with a `login` block is listed, even before a pod has it). All of them go through the base's `agent-login.sh`, then restart the agent in that pod and in the machine's other pods waiting for a sign-in (`PANEM_ONLY_AGENT=<id> post-start.sh`). Panem passes the terminal through and never reads or keeps what's in it.
- `share` lists files, relative to `$HOME`, that hold the login. Before each start, the base keeps them in `/var/lib/panem/logins/<id>/` and links them back. That's a Docker volume per machine (`panem-logins`), mounted by the controller's generated config, so one sign-in serves every pod on the machine.
- The base records whether the pod shares the machine's sign-in in `~/.panem/agents/<id>.login.json`: `{"shared": true}`, or `{"shared": false, "reason": "…"}` when the volume isn't mounted, isn't writable (it first tries `sudo -n chmod 1777`), or holds another user's sign-in. The UI shows the reason; an agent's `start.sh` may add it to its message.
- When `start.sh` finds no usable login, report `needs-login`: the UI then offers the agent's sign-in.

To work in templates that list only the agent, the Feature carries the base as `panem-base/` and installs it when it's missing or older (see `src/claude-code/install.sh`).
- `bun scripts/vendor-feature-base.ts` refreshes every agent's copy.
- A test fails if a copy is stale.

Adding an agent also means:
- a sync preset for its files (`PRESETS` in `packages/core/src/sync.ts`);
- the credential names its templates list in `env`.

## Tests

- `bun test features`: the base and agent hooks against local repos, a stub `claude`, a private tmux server and a sudo that always refuses; the install scripts' upgrade logic; the vendored copy.
- `devcontainer features test --project-folder features --features panem claude-code --skip-autogenerated`: real image builds for the base alone, the base plus `claude-code`, and `claude-code` alone. None of them installs Claude Code.
