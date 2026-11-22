import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type Mapping,
  type PodBackend,
  type PodMeta,
  type ResolvedSync,
  expandRules,
  exportRoots,
  legacyPodPath,
  mapOut,
  resolveSync,
} from "@panem/core";
import { mergeFile } from "./merge";
import { EXPORT_SCRIPT, bashCommand } from "./pod/scripts";
import { listFiles } from "./sources";
import type { Workspace } from "./workspace";

/** Export limits: memory is small; anything bigger is a mistake worth a clear error. */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const EXPORT_MAX_FILES = 5000;

/** Pod root ("~/x") as an export.sh argument ("h:x"). */
export function exportArg(root: string): string {
  if (root.startsWith("~/")) return `h:${root.slice(2)}`;
  throw new Error(`agent memory must be under ~/: ${root}`);
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

/** Sync of a pod created before sync rules existed: the defaults. */
export function syncOf(pod: PodMeta): ResolvedSync {
  return pod.sync ?? resolveSync(undefined, { name: pod.template });
}

/** Whether deleting this pod saves anything (it has agent memory to save). */
export function hasMemory(pod: PodMeta): boolean {
  return syncOf(pod).rules.some((r) => r.memory);
}

/** "~/.claude/projects/-workspace-api/..." (pods from before the rename) -> "-codebase-api". */
function fromLegacy(p: string): string {
  return p.replace(/^~\/\.claude\/projects\/-workspace-/, "~/.claude/projects/-codebase-");
}

export interface ExportResult {
  /** Memory files changed in the workspace folder, relative to it. */
  files: string[];
  /** Files whose pod version wasn't used (binary changed on both sides). */
  notes: string[];
}

interface PodFile extends Mapping {
  /** Where the pod's copy was unpacked on the controller. */
  local: string;
}

/**
 * Save the pod's agent memory into the workspace folder: each file is union-merged against
 * the copy the pod was given (kept in `memoryBase` at copy-in), so edits made in the folder
 * meanwhile are kept. Nothing else is ever written back; work other than memory is pushed by
 * the pod's before-destroy hooks.
 */
export async function exportPod(
  d: { backend: PodBackend; workspace: Workspace; memoryBase: string },
  pod: PodMeta,
  opts: { maxBytes?: number; maxFiles?: number } = {},
): Promise<ExportResult> {
  const sync = syncOf(pod);
  const rules = expandRules(
    sync.rules,
    pod.repos.map((r) => r.name),
  );
  const roots = exportRoots(rules);
  if (roots.length === 0) return { files: [], notes: [] };
  const withLegacy = [
    ...roots,
    ...roots.map(legacyPodPath).filter((x): x is string => x !== undefined),
  ];

  const res = await d.backend.exec(pod.id, exportCommand(withLegacy, opts));
  if (res.exitCode !== 0) {
    throw new Error(`reading memory from the pod failed: ${res.stderr.trim().split("\n").at(-1)}`);
  }
  const tmp = await mkdtemp(join(tmpdir(), "panem-export-"));
  try {
    const files = await unpack(new TextDecoder().decode(res.stdout), tmp);
    const byPath = new Map(files.map((f) => [fromLegacy(f.podPath), f.local]));
    const mapped: PodFile[] = mapOut(rules, [...byPath.keys()], sync.exclude).map((m) => ({
      ...m,
      local: byPath.get(m.dest)!,
    }));
    if (mapped.length === 0) return { files: [], notes: [] };
    const dir = await d.workspace.dir();
    return await d.workspace.lock.run(async () => {
      const r = await apply(dir, d.memoryBase, mapped);
      if (r.files.length > 0) {
        // e.g. commit and push the folder: memory is already safe in it, so a failure only
        // means the backup waits for the next save.
        const hook = await d.workspace.runHookUnlocked("afterMemorySave", {
          PANEM_POD_ID: pod.id,
          PANEM_SAVED_FILES: r.files.join("\n"),
        });
        if (hook.error) r.notes.push(hook.error);
      }
      return r;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Decode export.sh output ($HOME line, code-root line, base64 tar) into pod paths. */
async function unpack(out: string, dir: string): Promise<{ podPath: string; local: string }[]> {
  const [home, , b64 = ""] = out.split("\n");
  const data = b64.trim();
  if (!home || !data) return [];
  const tgz = join(dir, "export.tgz");
  await writeFile(tgz, Buffer.from(data, "base64"));
  const x = join(dir, "x");
  await mkdir(x);
  const p = Bun.spawn(["tar", "-xzf", tgz, "-C", x], { stderr: "pipe" });
  if ((await p.exited) !== 0) {
    throw new Error(`could not unpack memory from the pod: ${await new Response(p.stderr).text()}`);
  }
  const files: { podPath: string; local: string }[] = [];
  for (const rel of await listFiles(x)) {
    const abs = `/${rel}`;
    if (abs.startsWith(`${home}/`)) {
      files.push({ podPath: `~/${abs.slice(home.length + 1)}`, local: join(x, rel) });
    }
  }
  return files;
}

/** Keep writes inside the folder, whatever a path says. */
function inside(root: string, rel: string): string {
  const base = resolve(root);
  const p = resolve(base, rel);
  if (!p.startsWith(base + sep)) throw new Error(`path escapes the workspace: ${rel}`);
  return p;
}

async function apply(dir: string, memoryBase: string, files: PodFile[]): Promise<ExportResult> {
  const changed: string[] = [];
  const notes: string[] = [];
  for (const f of files) {
    const dest = inside(dir, f.src);
    if (relative(dir, dest).split(sep)[0] === ".git") continue;
    const current = existsSync(dest) ? await readBytes(dest) : undefined;
    // Pods from before memory bases were kept have none: union keeps both sides' lines.
    const basePath = join(memoryBase, f.src);
    const base = existsSync(basePath) ? await readBytes(basePath) : undefined;
    const out = await mergeFile(current, base, await readBytes(f.local));
    if (out.note) notes.push(`${f.src}: ${out.note}`);
    if (out.content) {
      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.panem-${process.pid}.tmp`;
      await writeFile(tmp, out.content);
      await rename(tmp, dest);
      changed.push(f.src);
    }
  }
  return { files: changed, notes };
}

async function readBytes(p: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(p));
}
