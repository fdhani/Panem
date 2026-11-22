import { describe, expect, test } from "bun:test";
import {
  AgentInfo,
  Config,
  DEFAULT_RULES,
  DEFAULT_SYNC,
  EnvName,
  PRESETS,
  Template,
  agentCredentials,
  resolveSync,
} from "../src";

const base = { workspaceRepoUrl: "x", apiToken: "a".repeat(16) };

describe("agent credentials", () => {
  test("env names: uppercase, PANEM_* reserved", () => {
    expect(EnvName.safeParse("OPENAI_API_KEY").success).toBe(true);
    expect(EnvName.safeParse("openai").success).toBe(false);
    expect(EnvName.safeParse("A-B").success).toBe(false);
    expect(EnvName.safeParse("PANEM_RELAY_SECRET").success).toBe(false);
  });

  test("the older claudeOauthToken still reaches pods; agentEnv wins on conflict", () => {
    expect(agentCredentials(Config.parse({ ...base, claudeOauthToken: "old" }))).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "old",
    });
    expect(
      agentCredentials(
        Config.parse({
          ...base,
          claudeOauthToken: "old",
          agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: "new", OPENAI_API_KEY: "sk" },
        }),
      ),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "new", OPENAI_API_KEY: "sk" });
    expect(() => Config.parse({ ...base, agentEnv: { PANEM_X: "y" } })).toThrow();
  });

  test("templates list the credentials they need", () => {
    const t = Template.parse({
      name: "t",
      repos: [{ name: "a", url: "u" }],
      env: ["OPENAI_API_KEY"],
    });
    expect(t.env).toEqual(["OPENAI_API_KEY"]);
    expect(() =>
      Template.parse({ name: "t", repos: [{ name: "a", url: "u" }], env: ["PANEM_RELAY_SECRET"] }),
    ).toThrow();
  });

  test("agent info from agents.json", () => {
    expect(AgentInfo.parse({ id: "x" })).toEqual({ id: "x", label: "", connect: [] });
    expect(() =>
      AgentInfo.parse({ id: "x", connect: [{ label: "a", url: "not a url" }] }),
    ).toThrow();
  });
});

describe("sync presets", () => {
  const tpl = { name: "shop" };

  test("the default is the claude-code preset, expanding to today's rules", () => {
    expect(DEFAULT_SYNC).toEqual([{ preset: "claude-code" }]);
    expect(DEFAULT_RULES).toBe(PRESETS["claude-code"]!);
    const viaDefault = resolveSync(undefined, tpl).rules;
    const viaPreset = resolveSync({ sync: [{ preset: "claude-code" }] }, tpl).rules;
    expect(viaPreset).toEqual(viaDefault);
    expect(viaDefault.map((r) => r.to)).toContain("~/.claude/CLAUDE.md");
  });

  test("presets mix with custom rules, in order", () => {
    const r = resolveSync(
      { sync: [{ from: "AGENTS.md", to: "~/AGENTS.md" }, { preset: "claude-code" }] },
      tpl,
    ).rules;
    expect(r[0]!.from).toBe("AGENTS.md");
    expect(r).toHaveLength(1 + PRESETS["claude-code"]!.length);
  });

  test("unknown or malformed presets are rejected, naming the entry", () => {
    expect(() => resolveSync({ sync: [{ preset: "codex" }] }, tpl)).toThrow(
      /panem\.json sync\[0\]: unknown preset "codex" \(known: claude-code\)/,
    );
    expect(() => resolveSync({ sync: [{ preset: "claude-code", from: "x" }] }, tpl)).toThrow(
      /a preset entry is just/,
    );
    expect(() => resolveSync({}, { ...tpl, sync: [{ preset: "nope" }] })).toThrow(
      /template shop sync\[0\]: unknown preset/,
    );
  });
});
