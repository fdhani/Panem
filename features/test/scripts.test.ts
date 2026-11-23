// Exercises the Panem base hooks and the claude-code agent hooks, installed into a temp
// "share" folder laid out like /usr/local/share/panem in a pod, against local git repos, a
// stub `claude`, a private tmux server, and a sudo that always refuses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFeatures, staleFiles } from "../../scripts/vendor-feature-base";

const src = join(import.meta.dir, "../src");
const root = mkdtempSync(join(tmpdir(), "panem-feature-"));
const bin = join(root, "bin");
const tmuxSock = join(root, "tmux.sock");
let n = 0;

/** A fresh pod: its own $HOME, code root and share folder with the base + given agents. */
function pod(agents: Record<string, string> = { "claude-code": "" }) {
  const dir = join(root, `pod${++n}`);
  const home = join(dir, "home");
  const code = join(dir, "codebase");
  const share = join(dir, "share");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(share, "agents"), { recursive: true });
  cpSync(join(src, "panem/scripts"), share, { recursive: true });
  for (const [id, agentEnv] of Object.entries(agents)) {
    const dest = join(share, "agents", id);
    if (existsSync(join(src, id, "agent")))
      cpSync(join(src, id, "agent"), dest, { recursive: true });
    else mkdirSync(dest, { recursive: true });
    if (agentEnv) writeFileSync(join(dest, "agent.env"), agentEnv);
  }
  const run = (script: string, env: Record<string, string> = {}, check = true) => {
    const p = Bun.spawnSync(["bash", join(share, script)], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        PANEM_CODE_ROOT: code,
        ...env,
      },
    });
    if (check && p.exitCode !== 0) throw new Error(`${script}: ${p.stderr.toString()}`);
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const agent = (id: string, files: Record<string, string>) => {
    const d = join(share, "agents", id);
    mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      writeFileSync(join(d, f), c);
      if (f.endsWith(".sh")) chmodSync(join(d, f), 0o755);
    }
  };
  return { dir, home, code, share, run, agent };
}

function makeRepo(name: string) {
  const dir = join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  const g = "git -c user.email=t@t -c user.name=t";
  Bun.spawnSync([
    "bash",
    "-c",
    `cd '${dir}' && git init -q -b main && ${g} commit -q --allow-empty -m init && git checkout -q -b feat && echo hi > f.txt && git add f.txt && ${g} commit -q -m feat && git checkout -q main`,
  ]);
  return dir;
}

async function waitFor(path: string) {
  for (let i = 0; i < 50 && !existsSync(path); i++) await Bun.sleep(100);
}

let env: Record<string, string>;
const POD_ID = "shop-abc123";

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  // tmux wrapper on a private socket so tests never touch a real server.
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec ${Bun.which("tmux")} -S ${tmuxSock} "$@"\n`, {
    mode: 0o755,
  });
  // Like a host without passwordless sudo: every sudo call fails.
  writeFileSync(join(bin, "sudo"), "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n", {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, "claude"),
    // Writes next to where it runs (the pod's primary repo): tmux sessions inherit the tmux
    // server's environment, not the caller's, so an env var can't say where.
    [
      "#!/bin/sh",
      // `claude auth status --json`: signed in to claude.ai iff the login file exists (runs in
      // start.sh itself, so $HOME is the pod's).
      'if [ "$1" = auth ] && [ "$2" = status ]; then',
      '  if [ -f "$HOME/.claude/.credentials.json" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; else echo \'{"loggedIn":false,"authMethod":"none"}\'; fi',
      "  exit 0",
      "fi",
      'if [ "$1" = auth ] && [ "$2" = login ]; then',
      '  mkdir -p "$HOME/.claude" && echo \'{"claudeAiOauth":"x"}\' > "$HOME/.claude/.credentials.json" && echo signed-in',
      "  exit 0",
      "fi",
      'echo "$PWD $*" > .claude-stub.args',
      'echo "${CLAUDE_CODE_OAUTH_TOKEN:-}" > .claude-stub.token',
      // A pod whose primary repo has .rc-fails: Remote Control refuses at once.
      'if [ -f .rc-fails ]; then echo "Error: Remote Control requires a full-scope login token."; exit 1; fi',
      "sleep 30",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const api = makeRepo("api");
  const web = makeRepo("web");
  env = {
    CLAUDE_CODE_OAUTH_TOKEN: "tok-123",
    PANEM_RELAY_SECRET: "sec-1",
    PANEM_POD: JSON.stringify({
      id: POD_ID,
      template: "shop",
      repos: [
        { name: "api", url: api, ref: "feat" },
        { name: "web", url: web, ref: "main" },
      ],
    }),
  };
});

afterAll(() => {
  Bun.spawnSync(["tmux", "-S", tmuxSock, "kill-server"]);
  rmSync(root, { recursive: true, force: true });
});

describe("base: post-create", () => {
  test("clones repos at refs, records pod.json and agents.json, copies no context", () => {
    const p = pod();
    p.run("post-create.sh", env);
    expect(readFileSync(join(p.code, "api/f.txt"), "utf8")).toBe("hi\n");
    expect(existsSync(join(p.code, "web/f.txt"))).toBe(false);
    // Synced files are the controller's job (between setup and the start hook).
    expect(existsSync(join(p.home, ".claude/CLAUDE.md"))).toBe(false);
    // Panem's state lives in $HOME/.panem, outside the code tree.
    expect(JSON.parse(readFileSync(join(p.home, ".panem/pod.json"), "utf8")).id).toBe(POD_ID);
    expect(existsSync(join(p.code, ".panem"))).toBe(false);
    expect(JSON.parse(readFileSync(join(p.home, ".panem/agents.json"), "utf8"))).toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        connect: [{ label: "Open in Claude", url: "https://claude.ai/code" }],
        log: "~/.panem/remote-control.log",
        login: {
          label: "Sign in to Claude",
          command: "env -u CLAUDE_CODE_OAUTH_TOKEN claude auth login",
          share: [".claude/.credentials.json"],
        },
      },
    ]);
  });

  test("is idempotent", () => {
    const p = pod();
    p.run("post-create.sh", env);
    p.run("post-create.sh", env);
  });

  test("the pre-rename PANEM_WORKSPACE_ROOT is still honoured", () => {
    const p = pod();
    const legacy = join(p.dir, "legacy-root");
    p.run("post-create.sh", { ...env, PANEM_CODE_ROOT: "", PANEM_WORKSPACE_ROOT: legacy });
    expect(existsSync(join(legacy, "api/f.txt"))).toBe(true);
  });

  test("saves only the credentials the template opted in to (plus the relay secret)", () => {
    const p = pod();
    p.run("post-create.sh", {
      ...env,
      OPENAI_API_KEY: "sk-openai",
      OTHER_SECRET: "nope",
      PANEM_AGENT_ENV: "OPENAI_API_KEY,CLAUDE_CODE_OAUTH_TOKEN",
    });
    const saved = readFileSync(join(p.home, ".config/panem/env"), "utf8");
    expect(saved).toContain("OPENAI_API_KEY=sk-openai");
    expect(saved).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-123");
    expect(saved).toContain("PANEM_RELAY_SECRET=sec-1");
    expect(saved).not.toContain("OTHER_SECRET");
  });

  test("without PANEM_AGENT_ENV (older controllers) only the Claude token is saved", () => {
    const p = pod();
    p.run("post-create.sh", { ...env, OPENAI_API_KEY: "sk-openai" });
    const saved = readFileSync(join(p.home, ".config/panem/env"), "utf8");
    expect(saved).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-123");
    expect(saved).not.toContain("OPENAI_API_KEY");
  });

  test("runs every agent's setup; a failing setup fails post-create", () => {
    const p = pod({});
    p.agent("alpha", {
      "agent.json": '{"id":"alpha","label":"Alpha","connect":[]}',
      "setup.sh": '#!/bin/sh\necho "$PANEM_CODE_ROOT" > "$HOME/alpha-setup"\n',
    });
    p.agent("beta", { "agent.json": '{"id":"beta","label":"Beta","connect":[]}' });
    p.run("post-create.sh", env);
    expect(readFileSync(join(p.home, "alpha-setup"), "utf8").trim()).toBe(p.code);
    const agents = JSON.parse(readFileSync(join(p.home, ".panem/agents.json"), "utf8"));
    expect(agents.map((a: { id: string }) => a.id)).toEqual(["alpha", "beta"]);

    const q = pod({});
    q.agent("bad", { "agent.json": '{"id":"bad"}', "setup.sh": "#!/bin/sh\nexit 3\n" });
    const r = q.run("post-create.sh", env, false);
    expect(r.code).not.toBe(0);
    // post-create tees its output into ~/.panem/post-create.log, so look at both streams.
    expect(r.out + r.err).toContain("agent bad: setup failed");
  });

  test("a pod with no agents works and reports none", () => {
    const p = pod({});
    p.run("post-create.sh", env);
    expect(JSON.parse(readFileSync(join(p.home, ".panem/agents.json"), "utf8"))).toEqual([]);
    p.run("post-start.sh", { ...env, PANEM_RELAY_PORT: "17998" });
  });
});

describe("base: post-start", () => {
  test("runs every agent's start hook, even when one fails", () => {
    const p = pod({});
    p.agent("a-broken", { "start.sh": "#!/bin/sh\nexit 1\n" });
    p.agent("b-ok", { "start.sh": '#!/bin/sh\ntouch "$HOME/b-started"\n' });
    const r = p.run("post-start.sh", { ...env, PANEM_RELAY_SECRET: "" });
    expect(existsSync(join(p.home, "b-started"))).toBe(true);
    expect(r.err).toContain("agent a-broken: start hook failed");
  });

  test.skipIf(!Bun.which("socat"))("brings up the relay with the saved secret", async () => {
    const p = pod({});
    p.run("post-create.sh", env);
    const port = 17000 + Math.floor(Math.random() * 1000);
    // The secret comes from the saved env file, not the live environment.
    p.run("post-start.sh", { PANEM_RELAY_PORT: String(port) });
    let reply = "";
    for (let i = 0; i < 50 && !reply; i++) {
      await Bun.sleep(50);
      reply = Bun.spawnSync([
        "bash",
        "-c",
        `printf 'sec-1 meta\\n' | socat -t 2 - TCP:127.0.0.1:${port}`,
      ]).stdout.toString();
    }
    expect(JSON.parse(reply).id).toBe(POD_ID);
  });
});

describe("claude-code agent", () => {
  test("setup marks onboarding done and trusts the code root and repos", () => {
    const p = pod();
    p.run("post-create.sh", env);
    const cj = JSON.parse(readFileSync(join(p.home, ".claude.json"), "utf8"));
    expect(cj.hasCompletedOnboarding).toBe(true);
    expect(cj.projects[`${p.code}/api`].hasTrustDialogAccepted).toBe(true);
    expect(cj.projects[p.code].hasTrustDialogAccepted).toBe(true);
  });

  const signIn = (p: ReturnType<typeof pod>) => {
    mkdirSync(join(p.home, ".claude"), { recursive: true });
    writeFileSync(join(p.home, ".claude/.credentials.json"), '{"claudeAiOauth":"x"}');
  };
  const status = (p: ReturnType<typeof pod>) =>
    JSON.parse(readFileSync(join(p.home, ".panem/agents/claude-code.status.json"), "utf8"));
  const fast = { PANEM_RC_SETTLE_SECONDS: "1", PANEM_LOGINS_DIR: "/nonexistent" };

  test("signed in: Remote Control starts in the primary repo, without the setup-token", async () => {
    const p = pod();
    p.run("post-create.sh", env);
    signIn(p);
    const out = join(p.code, "api/.claude-stub");
    const { PANEM_POD: _, ...rest } = env;
    p.run("post-start.sh", { ...rest, ...fast, PANEM_RELAY_SECRET: "" });
    await waitFor(`${out}.args`);
    expect(readFileSync(`${out}.args`, "utf8")).toContain(
      `${p.code}/api remote-control --name ${POD_ID}`,
    );
    // The token would take precedence over the sign-in: it's left out.
    expect(readFileSync(`${out}.token`, "utf8").trim()).toBe("");
    expect(status(p)).toMatchObject({ id: "claude-code", state: "running" });
  });

  test("with only a setup-token, Remote Control isn't started and the card says it needs sign-in", () => {
    const p = pod();
    p.run("post-create.sh", env);
    p.run("post-start.sh", { ...fast, PANEM_RELAY_PORT: "17998" });
    expect(existsSync(join(p.code, "api/.claude-stub.args"))).toBe(false);
    expect(status(p)).toMatchObject({ state: "needs-login" });
    expect(status(p).message).toContain("claude.ai sign-in");
  });

  test("Remote Control exiting at once is reported with its message", async () => {
    const p = pod();
    p.run("post-create.sh", env);
    signIn(p);
    writeFileSync(join(p.code, "api/.rc-fails"), "");
    p.run("post-start.sh", { ...fast, PANEM_RELAY_PORT: "17996" });
    expect(status(p).state).toBe("error");
    expect(status(p).message).toContain("requires a full-scope login token");
  });

  test("turned off: reported as stopped, nothing started", async () => {
    const off = pod({ "claude-code": "PANEM_REMOTE_CONTROL=false\n" });
    off.run("post-create.sh", env);
    off.run("post-start.sh", { ...fast, PANEM_RELAY_PORT: "17997" });
    await Bun.sleep(300);
    expect(existsSync(join(off.code, "api/.claude-stub.args"))).toBe(false);
    expect(status(off).state).toBe("stopped");
  });

  test("one sign-in per machine: the login lives in the machine's volume, shared by its pods", () => {
    const logins = mkdtempSync(join(root, "logins-"));
    const a = pod();
    a.run("post-create.sh", env);
    // A login made in the pod before the volume existed moves into it.
    signIn(a);
    a.run("post-start.sh", { ...fast, PANEM_LOGINS_DIR: logins, PANEM_RELAY_PORT: "17995" });
    const shared = join(logins, "claude-code/.claude/.credentials.json");
    expect(existsSync(shared)).toBe(true);
    expect(readlinkSync(join(a.home, ".claude/.credentials.json"))).toBe(shared);
    expect(status(a).state).toBe("running");

    // Another pod on the same machine starts signed in.
    const b = pod();
    b.run("post-create.sh", env);
    b.run("post-start.sh", { ...fast, PANEM_LOGINS_DIR: logins, PANEM_RELAY_PORT: "17994" });
    expect(readlinkSync(join(b.home, ".claude/.credentials.json"))).toBe(shared);
    expect(status(b).state).toBe("running");
  });

  test("agent-login.sh runs the agent's own sign-in, straight into the shared volume", () => {
    const logins = mkdtempSync(join(root, "logins-"));
    const p = pod();
    p.run("post-create.sh", env);
    const r = Bun.spawnSync(["bash", join(p.share, "agent-login.sh"), "claude-code"], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: p.home, PANEM_LOGINS_DIR: logins },
    });
    expect(r.stdout.toString()).toContain("signed-in");
    expect(existsSync(join(logins, "claude-code/.claude/.credentials.json"))).toBe(true);
    const bad = Bun.spawnSync(["bash", join(p.share, "agent-login.sh"), "../x"], {
      env: { PATH: process.env.PATH!, HOME: p.home },
    });
    expect(bad.exitCode).not.toBe(0);
  });
});

describe("vendored base", () => {
  test("every agent Feature carries an up-to-date copy of the base", () => {
    expect(agentFeatures()).toContain("claude-code");
    for (const a of agentFeatures())
      expect({ agent: a, stale: staleFiles(a) }).toEqual({ agent: a, stale: [] });
  });

  test("agent hooks are executable and only source the base's lib.sh", () => {
    for (const a of agentFeatures()) {
      for (const f of readdirSync(join(src, a, "agent")).filter((x) => x.endsWith(".sh"))) {
        expect(readFileSync(join(src, a, "agent", f), "utf8")).toContain(
          '"$(dirname "$0")/../../lib.sh"',
        );
      }
    }
  });
});

// install.sh apt-gets missing packages, which needs root. Elsewhere, run these tests only when
// everything it would install is already there.
const canInstall =
  process.getuid?.() === 0 || ["git", "tmux", "jq", "curl", "socat"].every((b) => Bun.which(b));

describe.skipIf(!canInstall)("install scripts", () => {
  const install = (
    feature: string,
    share: string,
    code: string,
    extra: Record<string, string> = {},
  ) => {
    const p = Bun.spawnSync(["bash", join(src, feature, "install.sh")], {
      env: {
        PATH: process.env.PATH!,
        PANEM_INSTALL_SHARE: share,
        PANEM_INSTALL_CODE_ROOT: code,
        INSTALLCLAUDE: "false",
        ...extra,
      },
    });
    if (p.exitCode !== 0) throw new Error(`${feature}: ${p.stderr.toString()}`);
    return p.stdout.toString();
  };
  const vendored = readFileSync(join(src, "panem/VERSION"), "utf8").trim();

  test("the panemBuild option is recorded, for setup to check the image is current", () => {
    const d = mkdtempSync(join(root, "inst-"));
    const share = join(d, "share");
    install("claude-code", share, join(d, "codebase"), { PANEMBUILD: "b1234" });
    expect(readFileSync(join(share, "BUILD"), "utf8").trim()).toBe("b1234");
    const plain = join(mkdtempSync(join(root, "inst-")), "share");
    install("panem", plain, join(d, "codebase2"));
    expect(existsSync(join(plain, "BUILD"))).toBe(false);
  });

  test("the agent Feature alone brings the base and registers itself", () => {
    const d = mkdtempSync(join(root, "inst-"));
    const share = join(d, "share");
    const out = install("claude-code", share, join(d, "codebase"), { REMOTECONTROL: "false" });
    expect(out).toContain(`installing the pod base ${vendored}`);
    expect(existsSync(join(share, "post-create.sh"))).toBe(true);
    expect(readFileSync(join(share, "VERSION"), "utf8").trim()).toBe(vendored);
    expect(JSON.parse(readFileSync(join(share, "agents/claude-code/agent.json"), "utf8")).id).toBe(
      "claude-code",
    );
    expect(readFileSync(join(share, "agents/claude-code/agent.env"), "utf8")).toContain(
      "PANEM_REMOTE_CONTROL=false",
    );
    // Sticky and world-writable, like /tmp.
    expect(
      Bun.spawnSync(["stat", "-c", "%a", join(d, "codebase")])
        .stdout.toString()
        .trim(),
    ).toBe("1777");
  });

  test("an older base is upgraded; the same or a newer one is left alone", () => {
    const d = mkdtempSync(join(root, "inst-"));
    const share = join(d, "share");
    install("panem", share, join(d, "codebase"));
    expect(install("claude-code", share, join(d, "codebase"))).not.toContain(
      "installing the pod base",
    );

    writeFileSync(join(share, "VERSION"), "0.0.1\n");
    expect(install("claude-code", share, join(d, "codebase"))).toContain("found: 0.0.1");

    writeFileSync(join(share, "VERSION"), "99.0.0\n");
    expect(install("claude-code", share, join(d, "codebase"))).not.toContain(
      "installing the pod base",
    );
    expect(readFileSync(join(share, "VERSION"), "utf8").trim()).toBe("99.0.0");
  });
});

describe("base: git access", () => {
  const TOKEN = "glpat-never-leak-42";

  /** The files the controller places in the pod's home before setup (see git-access.ts). */
  function withGitFiles(p: ReturnType<typeof pod>) {
    const w = (rel: string, content: string, mode = 0o644) => {
      mkdirSync(join(p.home, rel, ".."), { recursive: true });
      writeFileSync(join(p.home, rel), content, { mode });
    };
    w(".panem/git/known_hosts", "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGitlabKey\n");
    w(".panem/git/ssh_config", "Host gitlab-work\n  HostName gitlab.com\n  Port 22\n  User git\n");
    w(".panem/git/https-hosts", "git.test oauth2\n");
    w(".config/panem/git-tokens", `git.test oauth2 ${TOKEN}\n`, 0o600);
  }

  test("host keys, aliases and the HTTPS helper are applied, once", () => {
    const p = pod();
    withGitFiles(p);
    p.run("post-create.sh", env);
    p.run("post-create.sh", env);
    const kh = readFileSync(join(p.home, ".ssh/known_hosts"), "utf8");
    expect(kh.match(/GitlabKey/g)).toHaveLength(1);
    const cfg = readFileSync(join(p.home, ".ssh/config"), "utf8").split("\n");
    expect(cfg[0]).toBe(`Include ${join(p.home, ".panem/git/ssh_config")}`);
    expect(cfg.filter((l) => l.startsWith("Include"))).toHaveLength(1);
    const gitconfig = readFileSync(join(p.home, ".gitconfig"), "utf8");
    expect(gitconfig).toContain('[credential "https://git.test"]');
    expect(gitconfig).toContain(`helper = ${join(p.share, "git-credential-panem.sh")}`);
    expect(gitconfig).toContain("username = oauth2");
    expect(gitconfig).not.toContain(TOKEN);
  });

  test("the credential helper answers only for its own HTTPS host", () => {
    const p = pod();
    withGitFiles(p);
    const ask = (input: string, op = "get") =>
      Bun.spawnSync(["bash", join(p.share, "git-credential-panem.sh"), op], {
        env: { PATH: process.env.PATH!, HOME: p.home },
        stdin: new TextEncoder().encode(input),
      }).stdout.toString();
    expect(ask("protocol=https\nhost=git.test\n\n")).toBe(`username=oauth2\npassword=${TOKEN}\n`);
    expect(ask("protocol=https\nhost=github.com\n\n")).toBe("");
    expect(ask("protocol=http\nhost=git.test\n\n")).toBe("");
    expect(ask("protocol=https\nhost=git.test\n\n", "store")).toBe("");
  });

  test("a failed clone names the repo and keeps git's message; no half-made repo is left", () => {
    const p = pod();
    const missing = join(root, "src", "does-not-exist");
    const r = p.run(
      "post-create.sh",
      {
        ...env,
        PANEM_POD: JSON.stringify({
          id: POD_ID,
          repos: [{ name: "api", url: missing, ref: "main" }],
        }),
      },
      false,
    );
    expect(r.code).not.toBe(0);
    const out = r.out + r.err;
    expect(out).toContain(`panem: clone of api (${missing}) at main failed:`);
    expect(out).toMatch(/does not exist|not a git repository|repository .* does not exist/i);
    expect(existsSync(join(p.code, "api"))).toBe(false);
  });

  test("a missing ref is reported the same way", () => {
    const p = pod();
    const r = p.run(
      "post-create.sh",
      {
        ...env,
        PANEM_POD: JSON.stringify({
          id: POD_ID,
          repos: [{ name: "api", url: makeRepo("refless"), ref: "no-such-branch" }],
        }),
      },
      false,
    );
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("panem: clone of api");
    expect(r.out + r.err).toContain("no-such-branch");
  });

  test("the token is in the helper's file and nowhere else in the pod", () => {
    const p = pod();
    withGitFiles(p);
    const r = p.run("post-create.sh", env);
    expect(r.out + r.err).not.toContain(TOKEN);
    const hits = Bun.spawnSync(["grep", "-rl", "--", TOKEN, p.dir])
      .stdout.toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(hits).toEqual([join(p.home, ".config/panem/git-tokens")]);
  });
});
