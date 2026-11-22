import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type Mapping,
  type PodBackend,
  type PodMeta,
  type ResolvedSync,
  WORKSPACE_SOURCE,
  expandRules,
  exportRoots,
  legacyPodPath,
  mapOut,
  resolveSync,
} from "@panem/core";
import { type WorkspaceRepo, git } from "./git";
import { mergeFile } from "./merge";
import { EXPORT_SCRIPT, bashCommand } from "./pod/scripts";
import { type Sources, listFiles } from "./sources";

/** Export limits: a stray rule (say, a node_modules folder) fails clearly instead of stalling. */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const EXPORT_MAX_FILES = 5000;

/** Pod root ("~/x" or "/codebase/r/x") as an export.sh argument ("h:x" / "c:r/x"). */
export function exportArg(root: string): string {
  if (root.startsWith("~/")) return `h:${root.slice(2)}`;
  if (root.startsWith("/codebase/")) return `c:${root.slice("/codebase/".length)}`;
  throw new Error(`unexpected pod path ${root}`);
}

export function exportCommand(
  roots: string[],
  limits: { maxBytes?: number; maxFiles?: number } = {},
): string {
  return bashCommand(EXPORT_SCRIPT, "panem-export", [
    limits.maxBytes ?? EXPORT_MAX_BYTES,
    limits.maxFiles ?? EXPORT_MAX_FILES,
    ...roots.map(exportArg),
  ]);
}

/** Sync of a pod created before sync rules existed: the defaults, based on workspaceSha. */
export function syncOf(pod: PodMeta): ResolvedSync {
  if (pod.sync) return pod.sync;
  const s = resolveSync(undefined, { name: pod.template });
  return { ...s, bases: { [WORKSPACE_SOURCE]: { commit: pod.workspaceSha } } };
}

/** "~/.claude/projects/-workspace-api/..." (pods from before the rename) -> "-codebase-api". */
function fromLegacy(p: string): string {
  return p.replace(/^~\/\.claude\/projects\/-workspace-/, "~/.claude/projects/-codebase-");
}

export interface SourceExport {
  /** Files changed in the source, relative to its root. */
  files: string[];
  commit?: string;
}

export interface ExportResult {
  sources: Record<string, SourceExport>;
  /** Files whose pod version wasn't used (e.g. binary changed on both sides). */
  notes: string[];
  /** Every file written, as "<path>" (workspace repo) or "<source>:<path>". */
  files: string[];
}

export class ExportError extends Error {
  constructor(
    message: string,
    /** Sources that finished before or despite the failure (skip them on retry). */
    readonly done: string[],
  ) {
    super(message);
    this.name = "ExportError";
  }
}

interface PodFile extends Mapping {
  /** Where the pod's copy was unpacked on the controller. */
  local: string;
}

/**
 * Pull every write-back file out of the pod and merge it into its source: commit and push for
 * git sources (retrying push races), write into the folder for dir sources. Sources listed in
 * `opts.done` are skipped (a retry after a partial failure). Throws ExportError if any source
 * failed, after trying all of them.
 */
export async function exportPod(
  d: { backend: PodBackend; sources: Sources },
  pod: PodMeta,
  opts: {
    done?: string[];
    onSourceDone?: (name: string) => Promise<void> | void;
    attempts?: number;
    maxBytes?: number;
    maxFiles?: number;
  } = {},
): Promise<ExportResult> {
  const sync = syncOf(pod);
  const rules = expandRules(
    sync.rules,
    pod.repos.map((r) => r.name),
  );
  const roots = exportRoots(rules);
  const result: ExportResult = { sources: {}, notes: [], files: [] };
  if (roots.length === 0) return result;
  const withLegacy = [
    ...roots,
    ...roots.map(legacyPodPath).filter((x): x is string => x !== undefined),
  ];

  const res = await d.backend.exec(pod.id, exportCommand(withLegacy, opts));
  if (res.exitCode !== 0) {
    const last = res.stderr.trim().split("\n").at(-1) ?? "";
    throw new ExportError(`reading files from the pod failed: ${last}`, opts.done ?? []);
  }
  const tmp = await mkdtemp(join(tmpdir(), "panem-export-"));
  try {
    const files = await unpack(new TextDecoder().decode(res.stdout), tmp);
    const byPath = new Map(files.map((f) => [fromLegacy(f.podPath), f.local]));
    const mapped: PodFile[] = mapOut(rules, [...byPath.keys()], sync.exclude).map((m) => ({
      ...m,
      local: byPath.get(m.dest)!,
    }));

    const bySource = new Map<string, PodFile[]>();
    for (const m of mapped) {
      bySource.set(m.rule.source, [...(bySource.get(m.rule.source) ?? []), m]);
    }

    const done = [...(opts.done ?? [])];
    const failed: string[] = [];
    for (const [name, list] of bySource) {
      if (done.includes(name)) continue;
      try {
        const r = await exportSource(
          d.sources,
          pod,
          sync,
          name,
          list,
          result.notes,
          opts.attempts ?? 3,
        );
        result.sources[name] = r;
        result.files.push(...r.files.map((f) => (name === WORKSPACE_SOURCE ? f : `${name}:${f}`)));
        done.push(name);
        await opts.onSourceDone?.(name);
      } catch (e) {
        failed.push(`${name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (failed.length) throw new ExportError(`export failed for ${failed.join("; ")}`, done);
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Decode export.sh output into pod paths ("~/..." / "/codebase/...") and local copies. */
async function unpack(out: string, dir: string): Promise<{ podPath: string; local: string }[]> {
  const [home, code, b64 = ""] = out.split("\n");
  const data = b64.trim();
  if (!home || !code || !data) return [];
  const tgz = join(dir, "export.tgz");
  await writeFile(tgz, Buffer.from(data, "base64"));
  const x = join(dir, "x");
  await mkdir(x);
  const p = Bun.spawn(["tar", "-xzf", tgz, "-C", x], { stderr: "pipe" });
  if ((await p.exited) !== 0) {
    throw new Error(`could not unpack files from the pod: ${await new Response(p.stderr).text()}`);
  }
  const files: { podPath: string; local: string }[] = [];
  for (const rel of await listFiles(x)) {
    const abs = `/${rel}`;
    let podPath: string | undefined;
    if (abs.startsWith(`${home}/`)) podPath = `~/${abs.slice(home.length + 1)}`;
    else if (abs.startsWith(`${code}/`)) podPath = `/codebase/${abs.slice(code.length + 1)}`;
    if (podPath) files.push({ podPath, local: join(x, rel) });
  }
  return files;
}

/** Keep writes inside the source's root, whatever a path says. */
function inside(root: string, rel: string): string {
  const base = resolve(root);
  const p = resolve(base, rel);
  if (!p.startsWith(base + sep)) throw new Error(`path escapes the source: ${rel}`);
  return p;
}

async function exportSource(
  sources: Sources,
  pod: PodMeta,
  sync: ResolvedSync,
  name: string,
  files: PodFile[],
  notes: string[],
  attempts: number,
): Promise<SourceExport> {
  const spec = name === WORKSPACE_SOURCE ? undefined : sync.sources[name];
  if (name !== WORKSPACE_SOURCE && !spec) throw new Error(`unknown source "${name}"`);
  const base = sync.bases[name];
  const repo = sources.repo(name, spec);

  if (!repo) {
    // Folder source: merge against the snapshot of what the pod was sent.
    const root = sources.dir(spec as { dir: string });
    const snap = await sources.snapshotReader(base && "snapshot" in base ? base.snapshot : "");
    try {
      const changed: string[] = [];
      for (const f of files) {
        const dest = inside(root, f.src);
        const current = existsSync(dest) ? await readBytes(dest) : undefined;
        const out = await mergeFile(
          current,
          await snap.read(f.src),
          await readBytes(f.local),
          f.rule.merge,
        );
        if (out.note) notes.push(`${name}:${f.src}: ${out.note}`);
        if (out.content) {
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, out.content);
          changed.push(f.src);
        }
      }
      return { files: changed };
    } finally {
      await snap.done();
    }
  }

  const commit =
    base && "commit" in base ? base.commit : name === WORKSPACE_SOURCE ? pod.workspaceSha : "";
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await repo.lock.run(() => applyAndPush(repo, pod, commit, files, notes, name));
    } catch (e) {
      lastErr = e;
      if (!isPushRace(e)) break;
    }
  }
  throw lastErr;
}

async function applyAndPush(
  repo: WorkspaceRepo,
  pod: PodMeta,
  baseCommit: string,
  files: PodFile[],
  notes: string[],
  name: string,
): Promise<SourceExport> {
  await repo.syncUnlocked();
  const changed: string[] = [];
  for (const f of files) {
    const dest = inside(repo.dir, f.src);
    if (relative(repo.dir, dest).split(sep)[0] === ".git") continue;
    const current = existsSync(dest) ? await readBytes(dest) : undefined;
    const base = await repo.showBytes(baseCommit, f.src);
    const out = await mergeFile(current, base, await readBytes(f.local), f.rule.merge);
    if (out.note) notes.push(`${name === WORKSPACE_SOURCE ? "" : `${name}:`}${f.src}: ${out.note}`);
    if (out.content) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out.content);
      changed.push(f.src);
    }
  }
  if (changed.length === 0) return { files: [] };
  await git(repo.dir, ["add", "--", ...changed]);
  await git(repo.dir, [
    "commit",
    "--quiet",
    "-m",
    `panem: export from ${pod.id}`,
    "-m",
    `Template: ${pod.template}\nMachine: ${pod.machine}\nRefs: ${pod.repos.map((r) => `${r.name}@${r.ref}`).join(", ")}`,
  ]);
  await git(repo.dir, ["push", "--quiet", "origin", `HEAD:${repo.branch}`]);
  return { files: changed, commit: await repo.headUnlocked() };
}

async function readBytes(p: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(p));
}

function isPushRace(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}\n${(e as { stderr?: string }).stderr ?? ""}` : "";
  return /rejected|fetch first|non-fast-forward/i.test(msg);
}
