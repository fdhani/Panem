import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { type WorkspaceRepo, git } from "./git";
import { mergeFile } from "./merge";
import { EXPORT_SCRIPT, bashCommand } from "./pod/scripts";
import { listFiles } from "./sources";

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
  /** Memory files changed in the workspace repo, relative to its root. */
  files: string[];
  commit?: string;
  /** Files whose pod version wasn't used (binary changed on both sides). */
  notes: string[];
}

interface PodFile extends Mapping {
  /** Where the pod's copy was unpacked on the controller. */
  local: string;
}

/**
 * Save the pod's agent memory into the workspace repo: union-merge each file against the
 * commit the pod was given, then commit and push (retrying push races). Nothing else is ever
 * written back; work other than memory is pushed by the pod's before-destroy hooks.
 */
export async function exportPod(
  d: { backend: PodBackend; repo: WorkspaceRepo },
  pod: PodMeta,
  opts: { attempts?: number; maxBytes?: number; maxFiles?: number } = {},
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

    let lastErr: unknown;
    for (let i = 0; i < (opts.attempts ?? 3); i++) {
      try {
        return await d.repo.lock.run(() => applyAndPush(d.repo, pod, mapped));
      } catch (e) {
        lastErr = e;
        if (!isPushRace(e)) break;
      }
    }
    throw lastErr;
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

/** Keep writes inside the repo, whatever a path says. */
function inside(root: string, rel: string): string {
  const base = resolve(root);
  const p = resolve(base, rel);
  if (!p.startsWith(base + sep)) throw new Error(`path escapes the workspace repo: ${rel}`);
  return p;
}

async function applyAndPush(
  repo: WorkspaceRepo,
  pod: PodMeta,
  files: PodFile[],
): Promise<ExportResult> {
  await repo.syncUnlocked();
  const changed: string[] = [];
  const notes: string[] = [];
  for (const f of files) {
    const dest = inside(repo.dir, f.src);
    if (relative(repo.dir, dest).split(sep)[0] === ".git") continue;
    const current = existsSync(dest) ? await readBytes(dest) : undefined;
    const base = await repo.showBytes(pod.workspaceSha, f.src);
    const out = await mergeFile(current, base, await readBytes(f.local));
    if (out.note) notes.push(`${f.src}: ${out.note}`);
    if (out.content) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out.content);
      changed.push(f.src);
    }
  }
  if (changed.length === 0) return { files: [], notes };
  await git(repo.dir, ["add", "--", ...changed]);
  await git(repo.dir, [
    "commit",
    "--quiet",
    "-m",
    `panem: save memory from ${pod.id}`,
    "-m",
    `Template: ${pod.template}\nMachine: ${pod.machine}\nRefs: ${pod.repos.map((r) => `${r.name}@${r.ref}`).join(", ")}`,
  ]);
  await git(repo.dir, ["push", "--quiet", "origin", `HEAD:${repo.branch}`]);
  return { files: changed, commit: await repo.headUnlocked(), notes };
}

async function readBytes(p: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(p));
}

function isPushRace(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}\n${(e as { stderr?: string }).stderr ?? ""}` : "";
  return /rejected|fetch first|non-fast-forward/i.test(msg);
}
