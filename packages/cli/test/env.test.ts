import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");

function cli(cfg: string, args: string[], stdin?: string) {
  const p = Bun.spawnSync(["bun", main, ...args], {
    env: { ...process.env, PANEM_CONFIG: cfg },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test("panem env set/ls/rm keeps values out of argv and output", () => {
  const dir = mkdtempSync(join(tmpdir(), "panem-cli-env-"));
  const cfg = join(dir, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      workspaceRepoUrl: "x",
      apiToken: "a".repeat(16),
      claudeOauthToken: "old-tok",
    }),
  );

  const set = cli(cfg, ["env", "set", "OPENAI_API_KEY"], "sk-secret\n");
  expect(set.code).toBe(0);
  expect(JSON.parse(readFileSync(cfg, "utf8")).agentEnv).toEqual({ OPENAI_API_KEY: "sk-secret" });
  expect(statSync(cfg).mode & 0o777).toBe(0o600);

  const ls = cli(cfg, ["env", "ls"]);
  expect(ls.out.trim().split("\n")).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]);
  expect(ls.out).not.toContain("sk-secret");
  expect(ls.out).not.toContain("old-tok");

  expect(cli(cfg, ["env", "set", "PANEM_RELAY_SECRET"], "x\n").code).not.toBe(0);
  expect(cli(cfg, ["env", "set", "lower"], "x\n").code).not.toBe(0);
  expect(cli(cfg, ["env", "set", "EMPTY_ONE"], "\n").code).not.toBe(0);

  // Removing the Claude token also clears the older claudeOauthToken setting.
  expect(cli(cfg, ["env", "rm", "CLAUDE_CODE_OAUTH_TOKEN"]).code).toBe(0);
  expect(cli(cfg, ["env", "ls"]).out.trim()).toBe("OPENAI_API_KEY");
});
