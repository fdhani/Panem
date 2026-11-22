// Exercises post-create.sh and start-rc.sh against local git repos and a stub `claude`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripts = join(import.meta.dir, "../src/claude-code/scripts");
const root = mkdtempSync(join(tmpdir(), "panem-feature-"));
const home = join(root, "home");
const ws = join(root, "codebase");
const ctx = join(root, "ctx");
const bin = join(root, "bin");
const tmuxSock = join(root, "tmux.sock");

function sh(cmd: string, cwd = root, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", "-c", cmd], {
    cwd,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  if (p.exitCode !== 0) throw new Error(`${cmd}\n${p.stderr.toString()}`);
  return p.stdout.toString();
}

function makeRepo(name: string) {
  const dir = join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  sh(
    "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b feat && echo hi > f.txt && git add f.txt && git -c user.email=t@t -c user.name=t commit -q -m feat && git checkout -q main",
    dir,
  );
  return dir;
}

let env: Record<string, string>;

beforeAll(() => {
  mkdirSync(home, { recursive: true });
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
    `#!/bin/sh\necho "$PWD $*" > ${root}/claude-args\necho "$CLAUDE_CODE_OAUTH_TOKEN" > ${root}/claude-token\nsleep 30\n`,
    { mode: 0o755 },
  );
  const api = makeRepo("api");
  const web = makeRepo("web");
  mkdirSync(join(ctx, "memory/api"), { recursive: true });
  mkdirSync(join(ctx, "skills/deploy"), { recursive: true });
  writeFileSync(join(ctx, "CLAUDE.md"), "# global\n");
  writeFileSync(join(ctx, "memory/api/MEMORY.md"), "- fact\n");
  writeFileSync(join(ctx, "skills/deploy/SKILL.md"), "skill\n");
  env = {
    PANEM_CODE_ROOT: ws,
    PANEM_CONTEXT_DIR: ctx,
    CLAUDE_CODE_OAUTH_TOKEN: "tok-123",
    PANEM_RELAY_SECRET: "sec-1",
    PANEM_POD: JSON.stringify({
      id: "shop-abc123",
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

test("post-create clones repos at refs and materializes context", () => {
  sh(`bash ${scripts}/post-create.sh`, root, env);
  expect(readFileSync(join(ws, "api/f.txt"), "utf8")).toBe("hi\n");
  expect(existsSync(join(ws, "web/f.txt"))).toBe(false);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# global\n");
  const projDir = ws.replace(/[^A-Za-z0-9-]/g, "-");
  expect(readFileSync(join(home, `.claude/projects/${projDir}-api/memory/MEMORY.md`), "utf8")).toBe(
    "- fact\n",
  );
  expect(existsSync(join(home, ".claude/skills/deploy/SKILL.md"))).toBe(true);
  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(cj.hasCompletedOnboarding).toBe(true);
  expect(cj.projects[`${ws}/api`].hasTrustDialogAccepted).toBe(true);
  // Panem's state lives in $HOME/.panem, outside the code tree.
  expect(JSON.parse(readFileSync(join(home, ".panem/pod.json"), "utf8")).id).toBe("shop-abc123");
  expect(existsSync(join(ws, ".panem"))).toBe(false);
});

test("the pre-rename PANEM_WORKSPACE_ROOT is still honoured", () => {
  const { PANEM_CODE_ROOT: _, ...rest } = env;
  const legacyHome = join(root, "legacy-home");
  mkdirSync(legacyHome, { recursive: true });
  const legacyRoot = join(root, "legacy-root");
  sh(`bash ${scripts}/post-create.sh`, root, {
    ...rest,
    PANEM_WORKSPACE_ROOT: legacyRoot,
    HOME: legacyHome,
  });
  expect(existsSync(join(legacyRoot, "api/f.txt"))).toBe(true);
});

test("post-create is idempotent", () => {
  sh(`bash ${scripts}/post-create.sh`, root, env);
});

test("start-rc launches remote control in the primary repo with the token", async () => {
  // Without PANEM_POD it must fall back to pod.json written by post-create.
  const { PANEM_POD: _, ...rest } = env;
  sh(`bash ${scripts}/start-rc.sh`, root, rest);
  for (let i = 0; i < 50 && !existsSync(join(root, "claude-args")); i++) await Bun.sleep(100);
  expect(readFileSync(join(root, "claude-args"), "utf8")).toContain(
    `${ws}/api remote-control --name shop-abc123`,
  );
  expect(readFileSync(join(root, "claude-token"), "utf8").trim()).toBe("tok-123");
  // Restart replaces the session rather than failing.
  sh(`bash ${scripts}/start-rc.sh`, root, rest);
  expect(sh("tmux list-sessions -F '#S'")).toBe("panem-rc\n");
});

test("start-rc reuses the token saved at create time", async () => {
  const { CLAUDE_CODE_OAUTH_TOKEN: _, PANEM_POD: __, ...rest } = env;
  rmSync(join(root, "claude-token"), { force: true });
  sh(`bash ${scripts}/start-rc.sh`, root, rest);
  for (let i = 0; i < 50 && !existsSync(join(root, "claude-token")); i++) await Bun.sleep(100);
  expect(readFileSync(join(root, "claude-token"), "utf8").trim()).toBe("tok-123");
});

test.skipIf(!Bun.which("socat"))(
  "post-start brings up the relay with the saved secret",
  async () => {
    const { PANEM_POD: _, PANEM_RELAY_SECRET: __, ...rest } = env;
    const port = 17000 + Math.floor(Math.random() * 1000);
    sh(`bash ${scripts}/post-start.sh`, root, { ...rest, PANEM_RELAY_PORT: String(port) });
    expect(sh("tmux list-sessions -F '#S' | sort")).toBe("panem-rc\npanem-relay\n");
    let reply = "";
    for (let i = 0; i < 50 && !reply; i++) {
      await Bun.sleep(50);
      reply = Bun.spawnSync([
        "bash",
        "-c",
        `printf 'sec-1 meta\\n' | socat -t 2 - TCP:127.0.0.1:${port}`,
      ]).stdout.toString();
    }
    expect(JSON.parse(reply).id).toBe("shop-abc123");
  },
);

test("start-rc skips cleanly without credentials", () => {
  const { CLAUDE_CODE_OAUTH_TOKEN: _, ...rest } = env;
  sh(`bash ${scripts}/start-rc.sh`, root, { ...rest, HOME: join(root, "empty-home") });
});
