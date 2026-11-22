import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");

function cli(cfg: string, args: string[], env: Record<string, string> = {}) {
  const { CLAUDE_CODE_OAUTH_TOKEN: _, ...base } = process.env;
  const p = Bun.spawnSync(["bun", main, ...args], {
    env: { ...base, PANEM_CONFIG: cfg, ...env },
    stdin: "ignore",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const tmpCfg = () => join(mkdtempSync(join(tmpdir(), "panem-init-")), "config.json");

describe("panem workspace", () => {
  /** A fake $HOME holding the config, plus a separate folder to use as the workspace. */
  function setup() {
    const home = mkdtempSync(join(tmpdir(), "panem-home-"));
    const cfg = join(home, ".config/panem/config.json");
    const env = { HOME: home, PANEM_DATA: join(home, ".local/share/panem") };
    expect(cli(cfg, ["init"], env).code).toBe(0);
    const ws = join(home, "panem-workspace");
    const run = (args: string[], cwd?: string) => {
      const { CLAUDE_CODE_OAUTH_TOKEN: _, ...base } = process.env;
      const p = Bun.spawnSync(["bun", main, ...args], {
        env: { ...base, PANEM_CONFIG: cfg, ...env },
        cwd,
        stdin: "ignore",
      });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const config = () => JSON.parse(readFileSync(cfg, "utf8"));
    return { home, cfg, ws, run, config };
  }

  test("init adds what's missing, never touches existing files, and saves the path", () => {
    const { ws, run, config } = setup();
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "CLAUDE.md"), "mine\n");
    const apiToken = config().apiToken;
    const r = run(["workspace", "init"], ws);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`workspace: ${ws}`);
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toBe("mine\n");
    expect(existsSync(join(ws, "templates/example/template.json"))).toBe(true);
    expect(existsSync(join(ws, "panem.json"))).toBe(true);
    expect(existsSync(join(ws, "memory"))).toBe(true);
    expect(config().workspaceDir).toBe(ws);
    expect(config().apiToken).toBe(apiToken); // secrets untouched

    const again = run(["workspace", "init", ws]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already the workspace");
    expect(again.out).not.toContain("added:");
    expect(run(["workspace", "show"]).out.trim()).toBe(ws);
  });

  test("refuses /, the home folder, and a folder holding Panem's config", () => {
    const { home, run, config } = setup();
    expect(run(["workspace", "init", "/"]).err).toContain("can't be /");
    expect(run(["workspace", "init", home]).err).toContain("home folder");
    expect(run(["workspace", "init", join(home, ".config")]).err).toContain("can't hold Panem's");
    expect(config().workspaceDir).toBeUndefined();
  });

  test("warns when the folder is large", () => {
    const { ws, run } = setup();
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "big.bin"), new Uint8Array(51 * 1024 * 1024));
    const r = run(["workspace", "init", ws]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("over 50 MB");
  });

  test("needs a controller config first", () => {
    const home = mkdtempSync(join(tmpdir(), "panem-home-"));
    const r = cli(join(home, "missing.json"), ["workspace", "init", join(home, "ws")]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("panem init");
  });

  test("an old config with a workspace repo explains how to move it", () => {
    const { cfg, run, config } = setup();
    writeFileSync(cfg, JSON.stringify({ ...config(), workspaceRepoUrl: "git@x:me/ws.git" }));
    const r = run(["workspace", "show"]);
    expect(r.out).toContain("git clone git@x:me/ws.git ~/panem-workspace");
    expect(r.out).toContain("panem workspace init");
    // serve stops with the same steps rather than running without templates.
    const serve = run(["serve"]);
    expect(serve.code).not.toBe(0);
    expect(serve.err).toContain("git clone git@x:me/ws.git ~/panem-workspace");
  });
});

test("examples/workspace is exactly what panem workspace init creates", async () => {
  const { SCAFFOLD } = await import("../src/scaffold");
  const root = join(import.meta.dir, "../../../examples/workspace");
  const files = Bun.spawnSync(["bash", "-c", `cd '${root}' && find . -type f | sort`])
    .stdout.toString()
    .trim()
    .split("\n")
    .map((f) => f.slice(2));
  expect(files).toEqual(Object.keys(SCAFFOLD).sort());
  for (const f of files) expect(readFileSync(join(root, f), "utf8")).toBe(SCAFFOLD[f]!);
});

describe("panem init", () => {
  test("a token from the environment goes into agentEnv, with when it was set", () => {
    const cfg = tmpCfg();
    const r = cli(cfg, ["init"], { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(r.code).toBe(0);
    const c = JSON.parse(readFileSync(cfg, "utf8"));
    expect(c.agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(c.agentEnvUpdated.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(c.claudeOauthToken).toBeUndefined();
    expect(r.err).not.toContain("deprecated");
  });

  test("--claude-token still works, with a deprecation warning", () => {
    const cfg = tmpCfg();
    const r = cli(cfg, ["init", "--claude-token", "tok"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("--claude-token is deprecated");
    expect(r.err).toContain("panem env set CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.parse(readFileSync(cfg, "utf8")).agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  test("without a token, the hint points to panem env set, never to --force", () => {
    const cfg = tmpCfg();
    const r = cli(cfg, ["init"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("panem env set CLAUDE_CODE_OAUTH_TOKEN");
    expect(r.out).not.toContain("--force");
  });

  test("running it again explains what --force would do", () => {
    const cfg = tmpCfg();
    cli(cfg, ["init"]);
    const again = cli(cfg, ["init"]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("--force starts over");
    expect(again.err).toContain("panem env set");
  });
});

test("no message suggests `panem init --force` as a fix", () => {
  const out = Bun.spawnSync([
    "grep",
    "-rn",
    "--include=*.ts",
    "--include=*.tsx",
    "init --force",
    join(import.meta.dir, "../../controller/src"),
    join(import.meta.dir, "../../web/src"),
    join(import.meta.dir, "../src"),
  ]).stdout.toString();
  expect(out).toBe("");
});
