import { describe, expect, test } from "bun:test";
import {
  GitRef,
  SummonRequest,
  Template,
  claudeProjectDir,
  machineProviderName,
  newPodId,
  primaryRepo,
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
      { name: "web", url: "git@github.com:me/web.git", ref: "feat/x" },
      { name: "api", url: "git@github.com:me/api.git", ref: "develop" },
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
    expect(claudeProjectDir("/workspace/api")).toBe("-workspace-api");
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
