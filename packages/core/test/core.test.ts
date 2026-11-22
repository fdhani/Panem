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
