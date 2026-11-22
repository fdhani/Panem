import { describe, expect, test } from "bun:test";
import {
  GitRef,
  SummonRequest,
  Template,
  claudeProjectDir,
  machineProviderName,
  newPodId,
  primaryRepo,
  repoPath,
  resolveRefs,
} from "../src";

const tpl = Template.parse({
  name: "shop",
  repos: [
    { name: "web", url: "git@github.com:me/web.git" },
    { name: "api", url: "git@github.com:me/api.git", ref: "develop", primary: true },
  ],
  devcontainerPath: "templates/shop/.devcontainer/devcontainer.json",
});

describe("core", () => {
  test("template defaults", () => {
    expect(tpl.repos[0]!.ref).toBe("main");
    expect(tpl.description).toBe("");
  });

  test("primary repo", () => {
    expect(primaryRepo(tpl).name).toBe("api");
  });

  test("resolveRefs applies overrides and rejects unknown repos", () => {
    expect(resolveRefs(tpl, { web: "feat/x" })).toEqual([
      { name: "api", url: "git@github.com:me/api.git", ref: "develop" },
      { name: "web", url: "git@github.com:me/web.git", ref: "feat/x" },
    ]);
    expect(() => resolveRefs(tpl, { nope: "x" })).toThrow();
  });

  test("git refs reject flag injection", () => {
    expect(GitRef.safeParse("feat/a-b_1.2").success).toBe(true);
    expect(GitRef.safeParse("--upload-pack=x").success).toBe(false);
    expect(GitRef.safeParse("a..b").success).toBe(false);
    expect(GitRef.safeParse("a b").success).toBe(false);
  });

  test("claude project dir matches Claude Code's scheme", () => {
    expect(claudeProjectDir("/codebase/api")).toBe("-codebase-api");
    expect(repoPath("api")).toBe("/codebase/api");
  });

  test("ids and names", () => {
    expect(newPodId("shop")).toMatch(/^shop-[a-z0-9]{6}$/);
    expect(machineProviderName("VPS.tail1234.ts.net")).toBe("m-vps");
  });

  test("summon request validation", () => {
    expect(SummonRequest.safeParse({ template: "shop", machine: "m-vps" }).success).toBe(true);
    expect(SummonRequest.safeParse({ template: "Shop!", machine: "m-vps" }).success).toBe(false);
  });
});

describe("credential writes", () => {
  test("concurrent writers (controller and CLI) don't lose each other's changes", async () => {
    const { mkdtempSync, readFileSync, statSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveConfig, setCredential, removeCredential, Config } = await import("../src");
    const path = join(mkdtempSync(join(tmpdir(), "panem-cfg-")), "config.json");
    await saveConfig(Config.parse({ workspaceRepoUrl: "x", apiToken: "a".repeat(16) }), path);
    // Another process writing at the same time: a CLI child.
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `const c = await import(${JSON.stringify(join(import.meta.dir, "../src"))}); for (let i = 0; i < 10; i++) await c.setCredential("CHILD_" + i, "v", ${JSON.stringify(path)});`,
      ],
      { stderr: "pipe" },
    );
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => setCredential(`PARENT_${i}`, "v", path)),
    );
    expect(await child.exited).toBe(0);
    const env = JSON.parse(readFileSync(path, "utf8")).agentEnv;
    expect(Object.keys(env)).toHaveLength(20);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.lock`)).toBe(false);
    await removeCredential("PARENT_0", path);
    expect(JSON.parse(readFileSync(path, "utf8")).agentEnv.PARENT_0).toBeUndefined();
    expect(() => setCredential("PANEM_X", "v", path)).toThrow();
  });
});

describe("upgradeConfig", () => {
  test("adds missing secrets, moves the old Claude token, and writes only when needed", async () => {
    const { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { upgradeConfig } = await import("../src");
    const path = join(mkdtempSync(join(tmpdir(), "panem-up-")), "config.json");
    writeFileSync(
      path,
      JSON.stringify({ workspaceRepoUrl: "x", apiToken: "a".repeat(16), claudeOauthToken: "old" }),
    );
    let n = 0;
    const r = await upgradeConfig(() => `secret-${n++}`.padEnd(16, "x"), path);
    expect(r.notes).toHaveLength(2);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.relaySecret).toBe("secret-0".padEnd(16, "x"));
    expect(cfg.forwarderToken).toBe("secret-1".padEnd(16, "x"));
    expect(cfg.claudeOauthToken).toBeUndefined();
    expect(cfg.agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("old");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.lock`)).toBe(false);

    // Nothing to do: the file isn't rewritten.
    const before = statSync(path).mtimeMs;
    await Bun.sleep(20);
    const again = await upgradeConfig(() => "never", path);
    expect(again.notes).toEqual([]);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("a value already in agentEnv wins over the old setting", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { upgradeConfig } = await import("../src");
    const path = join(mkdtempSync(join(tmpdir(), "panem-up-")), "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        workspaceRepoUrl: "x",
        apiToken: "a".repeat(16),
        relaySecret: "r".repeat(16),
        forwarderToken: "f".repeat(16),
        claudeOauthToken: "old",
        agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: "new" },
      }),
    );
    await upgradeConfig(() => "x", path);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("new");
    expect(cfg.claudeOauthToken).toBeUndefined();
    expect(cfg.relaySecret).toBe("r".repeat(16));
  });
});
