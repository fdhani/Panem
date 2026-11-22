import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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

describe("panem init", () => {
  test("a token from the environment goes into agentEnv, with when it was set", () => {
    const cfg = tmpCfg();
    const r = cli(cfg, ["init", "--workspace-repo", "x"], { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(r.code).toBe(0);
    const c = JSON.parse(readFileSync(cfg, "utf8"));
    expect(c.agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(c.agentEnvUpdated.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(c.claudeOauthToken).toBeUndefined();
    expect(r.err).not.toContain("deprecated");
  });

  test("--claude-token still works, with a deprecation warning", () => {
    const cfg = tmpCfg();
    const r = cli(cfg, ["init", "--workspace-repo", "x", "--claude-token", "tok"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("--claude-token is deprecated");
    expect(r.err).toContain("panem env set CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.parse(readFileSync(cfg, "utf8")).agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  test("without a token, the hint points to panem env set, never to --force", () => {
    const cfg = tmpCfg();
    const r = cli(cfg, ["init", "--workspace-repo", "x"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("panem env set CLAUDE_CODE_OAUTH_TOKEN");
    expect(r.out).not.toContain("--force");
  });

  test("running it again explains what --force would do", () => {
    const cfg = tmpCfg();
    cli(cfg, ["init", "--workspace-repo", "x"]);
    const again = cli(cfg, ["init", "--workspace-repo", "x"]);
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
