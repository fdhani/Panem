# claude-code Feature

Devcontainer Feature that turns a container into a Panem pod for Claude Code.
Everything Claude-specific lives here; the controller has no Claude code.

```jsonc
"features": {
  "ghcr.io/fdhani/panem/claude-code:0": {
    "installClaude": true,      // native installer
    "remoteControl": true,      // run `claude remote-control` in tmux on every start
    "permissionMode": "default" // for Remote Control sessions
  }
}
```

| Hook | Script | What it does |
| --- | --- | --- |
| install | `install.sh` | git, tmux, jq, Claude Code; creates `/workspace` |
| postCreateCommand | `post-create.sh` | clones `PANEM_POD.repos` into `/workspace/<repo>` at their refs; copies CLAUDE.md, skills, plans, and `memory/<repo>` from the workspace repo into `~/.claude`; pre-trusts `/workspace/*`; writes `/workspace/.panem/pod.json`; saves the token to `~/.config/panem/env` |
| postStartCommand | `start-rc.sh` | (re)starts `claude remote-control --name <pod id>` in tmux session `panem-rc`, in the primary repo. Logs to `/workspace/.panem/remote-control.log` |

Inputs (set by the controller): `PANEM_POD` (JSON pod metadata), `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`), and `PANEM_CONTEXT_DIR` (the workspace repo checkout; defaults to
the current directory, which is the workspace folder for lifecycle hooks).

Test: `bun test features` (scripts against local repos and a stub `claude`) and
`devcontainer features test --project-folder features/claude-code` (real image build).
