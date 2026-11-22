import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RULES,
  SyncConfigError,
  expandRules,
  exportRoots,
  globMatch,
  legacyPodPath,
  mapIn,
  mapOut,
  resolveSync,
  validateRule,
} from "../src";

const tpl = { name: "shop" };
const resolve = (panem: unknown, t: object = {}) => resolveSync(panem, { ...tpl, ...t });
const rule = (r: object) => resolve({ sync: [r] });
const rejects = (r: object, msg: string | RegExp, sources: object = {}) =>
  expect(() => resolve({ sources, sync: [r] })).toThrow(msg);

describe("globs", () => {
  test("** spans folders, * stays in one, ? is one char", () => {
    expect(globMatch("**/.DS_Store", ".DS_Store")).toBe(true);
    expect(globMatch("**/.DS_Store", "a/b/.DS_Store")).toBe(true);
    expect(globMatch("**/*.tmp", "x.tmp")).toBe(true);
    expect(globMatch("**/*.tmp", "a/x.tmp")).toBe(true);
    expect(globMatch("*.tmp", "a/x.tmp")).toBe(false);
    expect(globMatch("memory/*/scratch/**", "memory/api/scratch/a/b.md")).toBe(true);
    expect(globMatch("memory/*/scratch/**", "memory/api/notes.md")).toBe(false);
    expect(globMatch("a?.md", "ab.md")).toBe(true);
    expect(globMatch("a?.md", "a/.md")).toBe(false);
    // Regex characters are literal.
    expect(globMatch("a+b(1).md", "a+b(1).md")).toBe(true);
    expect(globMatch("a.md", "aXmd")).toBe(false);
  });
});

describe("resolveSync", () => {
  test("no panem.json gives today's defaults, all from the workspace folder", () => {
    const r = resolve(undefined);
    expect(r.rules).toHaveLength(DEFAULT_RULES.length);
    expect(r.rules.every((x) => x.source === "workspace")).toBe(true);
    // Only the preset's memory rule is saved back on delete.
    expect(r.rules.map((x) => [x.from, x.memory === true])).toEqual([
      ["CLAUDE.md", false],
      ["skills/**", false],
      ["plans/**", false],
      ["agents/**", false],
      ["commands/**", false],
      ["memory/{repo}/**", true],
    ]);
    // panem.json with sources but no sync also keeps the defaults.
    expect(resolve({ exclude: ["**/.DS_Store"] }).rules).toHaveLength(DEFAULT_RULES.length);
  });

  test("template sync replaces the root rules; excludes add up", () => {
    const r = resolve(
      {
        sync: [{ from: "CLAUDE.md", to: "~/.claude/CLAUDE.md" }],
        exclude: ["**/.DS_Store"],
      },
      { sync: [{ from: "skills/**", to: "~/.claude/skills/**" }], syncExclude: ["**/*.tmp"] },
    );
    expect(r.rules.map((x) => x.from)).toEqual(["skills/**"]);
    expect(r.exclude).toEqual(["**/.DS_Store", "**/*.tmp"]);
  });

  test("rules are copy-in; sources are kept", () => {
    const r = resolve({
      sources: { overlay: { git: "git@x:me/o.git" }, local: { dir: "~/ctx" } },
      sync: [{ source: "overlay", from: "{repo}/**", to: "/codebase/{repo}/**" }],
    });
    expect(r.rules[0]).toMatchObject({ source: "overlay", from: "{repo}/**" });
    expect(r.rules[0]!.memory).toBeUndefined();
    expect(r.sources.overlay).toEqual({ git: "git@x:me/o.git", ref: "main" });
    expect(r.sources.local).toEqual({ dir: "~/ctx" });
  });

  test("rejects bad rules with a message naming the rule", () => {
    rejects({ from: "../x", to: "~/x" }, /sync\[0\].*"\." or "\.\."/);
    rejects({ from: "/etc/passwd", to: "~/x" }, /relative to the source/);
    rejects({ from: "~/x", to: "~/x" }, /relative to the source/);
    rejects({ from: ".git/config", to: "~/x" }, /\.git/);
    rejects({ from: "a/**", to: "~/a" }, /both be files, or both be folders/);
    rejects({ from: "a/*.md", to: "~/a/*.md" }, /trailing "\/\*\*"/);
    rejects({ from: "a/**/b/**", to: "~/a/**" }, /trailing/);
    rejects({ from: "a", to: "~/a", include: "*.md" }, /include only applies to folder rules/);
    rejects({ from: "m/{repo}/**", to: "~/m/**" }, /\{repo\} on both sides or neither/);
    rejects({ from: "m/{name}/**", to: "~/m/{name}/**" }, /only placeholder/);
    rejects({ from: "{repo}/{repo}/**", to: "~/{repo}/{repo}/**" }, /more than once/);
    rejects({ from: "x", to: "/etc/x" }, /must start with ~\/ or \/codebase/);
    rejects({ from: "x", to: "/codebase/api/x" }, /\/codebase\/\{repo\}/);
    rejects({ from: "**", to: "~/**" }, /whole home folder/);
    rejects({ from: "x/**", to: "~/.panem/**" }, /Panem's own files/);
    rejects({ from: "x", to: "~/.config/panem/env" }, /Panem's own files/);
    rejects({ from: "x/**", to: "~/.config/**" }, /Panem's own files/);
    rejects({ source: "nope", from: "x", to: "~/x" }, /unknown source "nope"/);
    rejects({ from: "x", to: "~/x", typo: 1 }, /Unrecognized key/);
  });

  test("rules are copy-in only: flow, merge and memory are refused with an explanation", () => {
    rejects({ from: "notes/**", to: "~/notes/**", flow: "both" }, /copy-in only.*preset/);
    rejects({ from: "notes/**", to: "~/notes/**", merge: "union" }, /copy-in only/);
    rejects({ from: "notes/**", to: "~/notes/**", flow: "in" }, /copy-in only/);
    rejects(
      { from: "m/{repo}/**", to: "~/m/{repo}/**", memory: true },
      /"memory" is set by agent presets/,
    );
    // Template rules get the same treatment.
    expect(() => resolve({}, { sync: [{ from: "a", to: "~/a", flow: "out" }] })).toThrow(
      /template shop sync\[0\]: sync rules are copy-in only/,
    );
  });

  test("bad panem.json shapes are reported with their path", () => {
    expect(() => resolve({ sync: "nope" })).toThrow(/panem\.json: sync/);
    expect(() => resolve({ sources: { Bad: { dir: "x" } } })).toThrow(/panem\.json: sources/);
    expect(() => resolve({ sources: { a: { git: "x", dir: "y" } } })).toThrow(SyncConfigError);
  });
});

describe("mapping", () => {
  const defaults = resolve(undefined);
  const rules = expandRules(defaults.rules, ["api", "web"]);

  test("golden: defaults copy in exactly what post-create.sh used to (for the pod's repos)", () => {
    const files = [
      "CLAUDE.md",
      "skills/deploy/SKILL.md",
      "plans/p.md",
      "agents/a.md",
      "commands/c.md",
      "memory/api/MEMORY.md",
      "memory/api/sub/x.md",
      "memory/other/MEMORY.md", // not one of this pod's repos
      "templates/shop/template.json",
      "README.md",
    ];
    expect(
      mapIn(rules, "workspace", files, [])
        .map((m) => [m.src, m.dest])
        .sort(),
    ).toEqual(
      [
        ["CLAUDE.md", "~/.claude/CLAUDE.md"],
        ["agents/a.md", "~/.claude/agents/a.md"],
        ["commands/c.md", "~/.claude/commands/c.md"],
        ["memory/api/MEMORY.md", "~/.claude/projects/-codebase-api/memory/MEMORY.md"],
        ["memory/api/sub/x.md", "~/.claude/projects/-codebase-api/memory/sub/x.md"],
        ["plans/p.md", "~/.claude/plans/p.md"],
        ["skills/deploy/SKILL.md", "~/.claude/skills/deploy/SKILL.md"],
      ].sort(),
    );
  });

  test("golden: defaults export exactly what the exporter used to", () => {
    const pod = [
      "~/.claude/projects/-codebase-api/memory/MEMORY.md",
      "~/.claude/projects/-codebase-web/memory/sub/a.md",
      "~/.claude/projects/-codebase-api/session.jsonl",
      "~/.claude/projects/-codebase-other/memory/x.md",
      "~/.claude/skills/new/SKILL.md", // copy-in only
      "~/.claude/projects/-codebase-api/memory/../../escape",
    ];
    expect(mapOut(rules, pod, []).map((m) => [m.dest, m.src])).toEqual([
      ["~/.claude/projects/-codebase-api/memory/MEMORY.md", "memory/api/MEMORY.md"],
      ["~/.claude/projects/-codebase-web/memory/sub/a.md", "memory/web/sub/a.md"],
    ]);
    expect(exportRoots(rules)).toEqual([
      "~/.claude/projects/-codebase-api/memory",
      "~/.claude/projects/-codebase-web/memory",
    ]);
  });

  test("include, per-rule and global excludes", () => {
    const r = resolve({
      sync: [
        {
          from: "skills/**",
          to: "~/.claude/skills/**",
          include: "**/*.md",
          exclude: ["skills/wip/**"],
        },
      ],
      exclude: ["**/.DS_Store"],
    });
    const rs = expandRules(r.rules, []);
    const got = mapIn(
      rs,
      "workspace",
      [
        "skills/a/SKILL.md",
        "skills/a/run.sh",
        "skills/wip/x.md",
        "skills/.DS_Store",
        "skills/b/.DS_Store",
      ],
      r.exclude,
    ).map((m) => m.src);
    expect(got).toEqual(["skills/a/SKILL.md"]);
  });

  test("{repo} can sit inside a folder name", () => {
    const r = expandRules(rule({ from: "m/x-{repo}/**", to: "~/m/{repo}-y/**" }).rules, ["api"]);
    expect(mapIn(r, "workspace", ["m/x-api/a.md"], [])[0]!.dest).toBe("~/m/api-y/a.md");
  });

  test("overlay rules per repo, and rules only read their own source", () => {
    const r = resolve({
      sources: { overlay: { git: "x" } },
      sync: [
        { source: "overlay", from: "{repo}/**", to: "/codebase/{repo}/**" },
        { from: "CLAUDE.md", to: "~/.claude/CLAUDE.md" },
      ],
    });
    const rs = expandRules(r.rules, ["api"]);
    expect(
      mapIn(
        rs,
        "overlay",
        ["api/CLAUDE.md", "api/.specify/x.md", "web/CLAUDE.md", "CLAUDE.md"],
        [],
      ).map((m) => [m.src, m.dest, m.rule.repo]),
    ).toEqual([
      ["api/CLAUDE.md", "/codebase/api/CLAUDE.md", "api"],
      ["api/.specify/x.md", "/codebase/api/.specify/x.md", "api"],
    ]);
    expect(mapIn(rs, "workspace", ["CLAUDE.md", "api/CLAUDE.md"], []).map((m) => m.dest)).toEqual([
      "~/.claude/CLAUDE.md",
    ]);
    // Overlays are copy-in only: nothing in them is ever mapped back.
    expect(mapOut(rs, ["/codebase/api/specs/001.md", "/codebase/api/CLAUDE.md"], [])).toEqual([]);
    expect(exportRoots(rs)).toEqual([]);
  });

  test("later rules win on the same destination; only memory maps back, minus excludes", () => {
    const r = resolve({
      sync: [
        { from: "a.md", to: "~/x.md" },
        { from: "b.md", to: "~/x.md" },
        { from: "notes/**", to: "~/notes/**" },
        { preset: "claude-code" },
      ],
      exclude: ["memory/*/scratch/**"],
    });
    const rs = expandRules(r.rules, ["api"]);
    expect(mapIn(rs, "workspace", ["a.md", "b.md"], []).map((m) => m.src)).toEqual(["b.md"]);
    expect(
      mapOut(
        rs,
        [
          "~/notes/ok.md",
          "~/.claude/CLAUDE.md",
          "~/.claude/projects/-codebase-api/memory/MEMORY.md",
          "~/.claude/projects/-codebase-api/memory/scratch/tmp.md",
        ],
        r.exclude,
      ).map((m) => m.src),
    ).toEqual(["memory/api/MEMORY.md"]);
  });

  test("agent memory must come from the workspace folder and be a folder under ~/", () => {
    const where = "test";
    const base = {
      source: "workspace",
      from: "m/{repo}/**",
      to: "~/m/{repo}/**",
      exclude: [],
      memory: true,
    };
    expect(() => validateRule(base, {}, where)).not.toThrow();
    expect(() => validateRule({ ...base, source: "o" }, { o: {} }, where)).toThrow(
      /workspace folder/,
    );
    expect(() => validateRule({ ...base, from: "m.md", to: "~/m.md" }, {}, where)).toThrow(
      /folder under ~\//,
    );
    expect(() =>
      validateRule({ ...base, from: "{repo}/**", to: "/codebase/{repo}/**" }, {}, where),
    ).toThrow(/folder under ~\//);
  });

  test("legacy memory paths from before the rename", () => {
    expect(legacyPodPath("~/.claude/projects/-codebase-api/memory")).toBe(
      "~/.claude/projects/-workspace-api/memory",
    );
    expect(legacyPodPath("~/.claude/skills")).toBeUndefined();
  });
});
