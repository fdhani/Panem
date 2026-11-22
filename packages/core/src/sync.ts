import { z } from "zod";
import { GitRef } from "./refs";

/**
 * Sync rules: which files are copied from a source (the workspace repo, another git repo, or a
 * folder on the controller) into a pod at create time, and which come back out on delete.
 *
 * Paths:
 * - `from` is relative to the source's root.
 * - `to` is a pod path under `~/` (the pod user's home) or `/codebase/{repo}/` (an overlay
 *   onto a code repo).
 * - Each side is an exact file, or a folder prefix ending in `/**` whose remainder carries over.
 * - `{repo}` (at most once per side) expands over the pod's repos.
 * - Globs (`**`, `*`, `?`) are used for `include` and `exclude`; there is no regex anywhere.
 */

/** Rules without `source` read from the workspace repo. */
export const WORKSPACE_SOURCE = "workspace";
export const REPO_PLACEHOLDER = "{repo}";
export const POD_HOME = "~/";
export const POD_CODE_ROOT = "/codebase/";

const SourceName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "source names: lowercase letters, digits and dashes");

export const SyncSource = z.union([
  z.object({ git: z.string().min(1), ref: GitRef.default("main") }).strict(),
  z.object({ dir: z.string().min(1) }).strict(),
]);
export type SyncSource = z.infer<typeof SyncSource>;

export const SyncRule = z
  .object({
    source: SourceName.optional(),
    from: z.string().min(1),
    to: z.string().min(1),
    flow: z.enum(["in", "out", "both"]).default("in"),
    merge: z.enum(["union", "pod"]).default("union"),
    /** Folder rules only: glob on the path below the folder, e.g. "**\/*.md". */
    include: z.string().min(1).optional(),
    /** Globs on the source-relative path. */
    exclude: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type SyncRule = z.infer<typeof SyncRule>;
export type SyncRuleInput = z.input<typeof SyncRule>;

/** `{ "preset": "<agent id>" }` in a sync list stands for that agent's rules. */
export const PresetRef = z.object({ preset: z.string().min(1) }).strict();
/** One entry of a `sync` list: a rule or a preset. Checked one by one in resolveSync. */
export const SyncEntry = z.record(z.string(), z.unknown());
export type SyncEntryInput = SyncRuleInput | { preset: string };

/** `panem.json` at the root of the workspace repo. */
export const PanemConfig = z
  .object({
    sources: z.record(SourceName, SyncSource).default({}),
    sync: z.array(SyncEntry).optional(),
    exclude: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type PanemConfig = z.infer<typeof PanemConfig>;

/** What a pod was created with; export always uses this, not the repo's current panem.json. */
export const ResolvedSync = z.object({
  sources: z.record(z.string(), SyncSource),
  rules: z.array(SyncRule.extend({ source: z.string() })),
  exclude: z.array(z.string()),
  /** Per source: what was sent to the pod (the merge base on export). */
  bases: z
    .record(
      z.string(),
      z.union([z.object({ commit: z.string() }), z.object({ snapshot: z.string() })]),
    )
    .default({}),
});
export type ResolvedSync = z.infer<typeof ResolvedSync>;
export type ResolvedRule = ResolvedSync["rules"][number];

/**
 * Sync rules per agent, so `{ "preset": "claude-code" }` can stand in for them. Plain data:
 * adding an agent (say codex: AGENTS.md -> ~/.codex/AGENTS.md) is one more entry here.
 */
export const PRESETS: Record<string, SyncRuleInput[]> = {
  "claude-code": [
    { from: "CLAUDE.md", to: "~/.claude/CLAUDE.md", flow: "in" },
    ...["skills", "plans", "agents", "commands"].map(
      (d): SyncRuleInput => ({ from: `${d}/**`, to: `~/.claude/${d}/**`, flow: "in" }),
    ),
    {
      from: "memory/{repo}/**",
      to: "~/.claude/projects/-codebase-{repo}/memory/**",
      flow: "both",
      merge: "union",
    },
  ],
};

/** Used when there is no panem.json (or it has no `sync`): Claude Code, as Panem always did. */
export const DEFAULT_SYNC: SyncEntryInput[] = [{ preset: "claude-code" }];
/** The default sync, expanded. */
export const DEFAULT_RULES: SyncRuleInput[] = PRESETS["claude-code"]!;

export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConfigError";
  }
}

// ---------------------------------------------------------------- globs

const globCache = new Map<string, RegExp>();

/** `**` = any depth (incl. none), `*` = within one segment, `?` = one char. Anchored. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      // "**/" can match nothing, so "**/x" also matches "x" at the root.
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

// ---------------------------------------------------------------- rule shape

export interface PathShape {
  /** "skills" for "skills/**", the whole path for a file. No trailing slash. */
  prefix: string;
  isDir: boolean;
}

export function shape(path: string): PathShape {
  if (path === "**") return { prefix: "", isDir: true };
  if (path.endsWith("/**")) return { prefix: path.slice(0, -3), isDir: true };
  return { prefix: path, isDir: false };
}

const GLOB_CHARS = /[*?[\]]/;

function segments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

function checkPath(side: "from" | "to", p: string, where: string): void {
  const { prefix } = shape(p);
  if (GLOB_CHARS.test(prefix)) {
    throw new SyncConfigError(
      `${where}: ${side} "${p}" may only use a trailing "/**"; narrow folders with include/exclude`,
    );
  }
  const segs = segments(prefix);
  if (segs.some((s) => s === ".." || s === ".")) {
    throw new SyncConfigError(`${where}: ${side} "${p}" may not contain "." or ".." segments`);
  }
  if (segs.includes(".git")) {
    throw new SyncConfigError(`${where}: ${side} "${p}" may not reach into .git`);
  }
  // {repo} may sit inside a name ("-codebase-{repo}"); it's the only placeholder there is.
  const uses = prefix.split(REPO_PLACEHOLDER).length - 1;
  if (/[{}]/.test(prefix.split(REPO_PLACEHOLDER).join(""))) {
    throw new SyncConfigError(`${where}: ${side} "${p}": {repo} is the only placeholder`);
  }
  if (uses > 1) {
    throw new SyncConfigError(`${where}: ${side} "${p}" uses {repo} more than once`);
  }
}

/** Places a rule must never write in the pod: Panem's own state and secrets. */
const PROTECTED_POD = ["~/.panem", "~/.config/panem"];
/** Workspace-repo files a pod must never write back (they configure every pod). */
const PROTECTED_REPO_FILES = ["panem.json", ".gitattributes"];
const PROTECTED_REPO_DIRS = ["templates"];

export function validateRule(
  r: ResolvedRule,
  sources: Record<string, unknown>,
  where: string,
): void {
  if (r.source !== WORKSPACE_SOURCE && !(r.source in sources)) {
    throw new SyncConfigError(`${where}: unknown source "${r.source}"`);
  }
  if (r.from.startsWith("/") || r.from.startsWith("~")) {
    throw new SyncConfigError(`${where}: from "${r.from}" must be relative to the source`);
  }
  checkPath("from", r.from, where);
  checkPath("to", r.to, where);

  const from = shape(r.from);
  const to = shape(r.to);
  if (from.isDir !== to.isDir) {
    throw new SyncConfigError(
      `${where}: from and to must both be files, or both be folders ending in "/**"`,
    );
  }
  if (!from.isDir && r.include) {
    throw new SyncConfigError(`${where}: include only applies to folder rules`);
  }
  const fromRepo = r.from.includes(REPO_PLACEHOLDER);
  const toRepo = r.to.includes(REPO_PLACEHOLDER);
  if (fromRepo !== toRepo) {
    throw new SyncConfigError(`${where}: use {repo} on both sides or neither`);
  }

  if (r.to.startsWith(POD_HOME)) {
    if (to.prefix === "~" || to.prefix === "~/") {
      throw new SyncConfigError(`${where}: to "${r.to}" can't be the whole home folder`);
    }
    const target = to.prefix;
    if (
      PROTECTED_POD.some(
        (p) => target === p || target.startsWith(`${p}/`) || p.startsWith(`${target}/`),
      )
    ) {
      throw new SyncConfigError(`${where}: to "${r.to}" would touch Panem's own files`);
    }
  } else if (r.to.startsWith(POD_CODE_ROOT)) {
    // Overlays land inside one code repo, so its .git/info/exclude can keep them out of commits.
    if (segments(r.to)[1] !== REPO_PLACEHOLDER) {
      throw new SyncConfigError(`${where}: overlays must target /codebase/{repo}/...`);
    }
  } else {
    throw new SyncConfigError(`${where}: to "${r.to}" must start with ~/ or /codebase/{repo}/`);
  }

  const writesBack = r.flow === "out" || r.flow === "both";
  if (writesBack && r.source === WORKSPACE_SOURCE) {
    const p = from.prefix;
    const touches = (f: string) => (from.isDir ? p === "" || f.startsWith(`${p}/`) : f === p);
    const touchesDir = (d: string) =>
      p === "" || p === d || p.startsWith(`${d}/`) || (from.isDir && d.startsWith(`${p}/`));
    if (PROTECTED_REPO_FILES.some(touches) || PROTECTED_REPO_DIRS.some(touchesDir)) {
      throw new SyncConfigError(
        `${where}: rules that write back may not cover panem.json, .gitattributes or templates/`,
      );
    }
  }
}

/**
 * Rules for a pod: the template's `sync` replaces the root list; excludes add up.
 * Throws SyncConfigError with a message naming the bad rule.
 */
export function resolveSync(
  panemJson: unknown,
  template: { name: string; sync?: Record<string, unknown>[]; syncExclude?: string[] },
): ResolvedSync {
  const parsed = PanemConfig.safeParse(panemJson ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new SyncConfigError(`panem.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  const cfg = parsed.data;
  const fromTemplate = template.sync !== undefined;
  const raw: unknown[] = template.sync ?? cfg.sync ?? DEFAULT_SYNC;
  const rules: ResolvedRule[] = [];
  raw.forEach((entry, i) => {
    const where = `${fromTemplate ? `template ${template.name}` : "panem.json"} sync[${i}]`;
    const isPreset = typeof entry === "object" && entry !== null && "preset" in entry;
    let list: { r: unknown; where: string }[] = [{ r: entry, where }];
    if (isPreset) {
      const ref = PresetRef.safeParse(entry);
      if (!ref.success)
        throw new SyncConfigError(`${where}: a preset entry is just {"preset": "<id>"}`);
      const preset = PRESETS[ref.data.preset];
      if (!preset) {
        throw new SyncConfigError(
          `${where}: unknown preset "${ref.data.preset}" (known: ${Object.keys(PRESETS).join(", ")})`,
        );
      }
      list = preset.map((r, j) => ({ r, where: `${where} (preset ${ref.data.preset} rule ${j})` }));
    }
    for (const { r, where: w } of list) {
      const p = SyncRule.safeParse(r);
      if (!p.success) {
        const issue = p.error.issues[0]!;
        throw new SyncConfigError(`${w}: ${issue.path.join(".") || "rule"}: ${issue.message}`);
      }
      const rule = { ...p.data, source: p.data.source ?? WORKSPACE_SOURCE };
      validateRule(rule, cfg.sources, w);
      rules.push(rule);
    }
  });
  return {
    sources: cfg.sources,
    rules,
    exclude: [...cfg.exclude, ...(template.syncExclude ?? [])],
    bases: {},
  };
}

// ---------------------------------------------------------------- expansion & mapping

export interface ConcreteRule extends ResolvedRule {
  /** The repo {repo} was replaced with, if any. */
  repo?: string;
}

/** Replace {repo} with each of the pod's repos (one concrete rule per repo). */
export function expandRules(rules: ResolvedRule[], repos: string[]): ConcreteRule[] {
  const out: ConcreteRule[] = [];
  for (const r of rules) {
    if (!r.from.includes(REPO_PLACEHOLDER)) {
      out.push(r);
      continue;
    }
    for (const repo of repos) {
      out.push({
        ...r,
        from: r.from.replace(REPO_PLACEHOLDER, repo),
        to: r.to.replace(REPO_PLACEHOLDER, repo),
        repo,
      });
    }
  }
  return out;
}

function excluded(path: string, rule: ConcreteRule, globalExclude: string[]): boolean {
  return [...globalExclude, ...rule.exclude].some((g) => globMatch(g, path));
}

function remainder(prefix: string, path: string): string | undefined {
  if (prefix === "") return path;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
}

function join2(prefix: string, rest: string): string {
  return prefix === "" ? rest : `${prefix}/${rest}`;
}

export interface Mapping {
  /** Path relative to the source root. */
  src: string;
  /** Pod path ("~/..." or "/codebase/<repo>/..."). */
  dest: string;
  rule: ConcreteRule;
}

/** Files to copy into the pod from one source's file list. Later rules win on the same dest. */
export function mapIn(
  rules: ConcreteRule[],
  source: string,
  files: string[],
  globalExclude: string[],
): Mapping[] {
  const byDest = new Map<string, Mapping>();
  for (const rule of rules) {
    if (rule.source !== source || rule.flow === "out") continue;
    const from = shape(rule.from);
    const to = shape(rule.to);
    for (const f of files) {
      let dest: string | undefined;
      if (!from.isDir) dest = f === from.prefix ? to.prefix : undefined;
      else {
        const rest = remainder(from.prefix, f);
        if (rest === undefined || (rule.include && !globMatch(rule.include, rest))) continue;
        dest = join2(to.prefix, rest);
      }
      if (dest === undefined || excluded(f, rule, globalExclude)) continue;
      byDest.set(dest, { src: f, dest, rule });
    }
  }
  return [...byDest.values()];
}

/** Map pod files back to source paths, for rules that write back. First matching rule wins. */
export function mapOut(
  rules: ConcreteRule[],
  podFiles: string[],
  globalExclude: string[],
): Mapping[] {
  const out: Mapping[] = [];
  const outRules = rules.filter((r) => r.flow !== "in");
  for (const f of podFiles) {
    if (segments(f).some((s) => s === ".." || s === ".")) continue;
    for (const rule of outRules) {
      const from = shape(rule.from);
      const to = shape(rule.to);
      let src: string | undefined;
      if (!to.isDir) src = f === to.prefix ? from.prefix : undefined;
      else {
        const rest = remainder(to.prefix, f);
        if (rest === undefined || (rule.include && !globMatch(rule.include, rest))) continue;
        src = join2(from.prefix, rest);
      }
      if (src === undefined) continue;
      if (!excluded(src, rule, globalExclude)) out.push({ src, dest: f, rule });
      break;
    }
  }
  return out;
}

/** Pod paths to collect on export: each write-back rule's file or folder. */
export function exportRoots(rules: ConcreteRule[]): string[] {
  const roots = new Set<string>();
  for (const r of rules) if (r.flow !== "in") roots.add(shape(r.to).prefix);
  return [...roots].sort();
}

/** Pods from before the /codebase rename keep Claude memory under -workspace-<repo>. */
export function legacyPodPath(p: string): string | undefined {
  const m = p.match(/^~\/\.claude\/projects\/-codebase-(.*)$/);
  return m ? `~/.claude/projects/-workspace-${m[1]}` : undefined;
}
