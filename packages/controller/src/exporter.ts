import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type PodBackend, type PodMeta, claudeProjectDir, repoPath } from "@panem/core";
import { type WorkspaceRepo, git } from "./git";
import { unionMerge } from "./merge";

/**
 * Runs inside the pod. Prints a base64 tarball of every file in a memory/ folder under Claude's
 * projects folder (base64 because the SSH transport isn't guaranteed binary-safe).
 */
export const EXPORT_COMMAND = [
  'd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"',
  '[ -d "$d" ] || exit 0',
  'cd "$d"',
  // tar writes to a file (not a pipe) so a tar failure fails the whole command instead of
  // looking like "no memory" and letting the pod be deleted.
  't="$(mktemp)"',
  "find . -path '*/memory/*' -type f -print0 | tar --null -czf \"$t\" -T -",
  "base64 \"$t\" | tr -d '\\n'",
  'rm -f "$t"',
].join(" && ");

export interface ExportResult {
  /** Files changed in the workspace repo, relative to its root. */
  files: string[];
  commit?: string;
}

/** Pull memory out of the pod and push it to the workspace repo. Retries on push races. */
export async function exportMemory(
  backend: PodBackend,
  repo: WorkspaceRepo,
  pod: PodMeta,
  opts: { attempts?: number } = {},
): Promise<ExportResult> {
  const res = await backend.exec(pod.id, EXPORT_COMMAND);
  if (res.exitCode !== 0) {
    throw new Error(`reading memory from pod failed: ${res.stderr.trim().split("\n").at(-1)}`);
  }
  const tmp = await mkdtemp(join(tmpdir(), "panem-export-"));
  try {
    const files = await unpack(new TextDecoder().decode(res.stdout).trim(), tmp);
    const mapped = mapToWorkspace(files, pod);
    if (mapped.length === 0) return { files: [] };

    const attempts = opts.attempts ?? 3;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await repo.lock.run(() => applyAndPush(repo, pod, tmp, mapped));
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

async function unpack(b64: string, dir: string): Promise<string[]> {
  if (!b64) return [];
  const tgz = join(dir, "memory.tgz");
  await writeFile(tgz, Buffer.from(b64, "base64"));
  const out = join(dir, "x");
  await mkdir(out);
  const p = Bun.spawn(["tar", "-xzf", tgz, "-C", out], { stderr: "pipe" });
  if ((await p.exited) !== 0) {
    throw new Error(`could not unpack memory: ${await new Response(p.stderr).text()}`);
  }
  return (await walk(out)).map((f) => relative(out, f));
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** "-workspace-api/memory/MEMORY.md" -> "memory/api/MEMORY.md", only for the pod's own repos. */
export function mapToWorkspace(files: string[], pod: PodMeta): { src: string; dest: string }[] {
  const byProject = new Map(pod.repos.map((r) => [claudeProjectDir(repoPath(r.name)), r.name]));
  const out: { src: string; dest: string }[] = [];
  for (const f of files) {
    const [project, mem, ...rest] = f.replace(/^\.\//, "").split("/");
    const repoName = project ? byProject.get(project) : undefined;
    if (!repoName || mem !== "memory" || rest.length === 0) continue;
    if (rest.some((s) => s === ".." || s === "")) continue;
    out.push({ src: join("x", f), dest: join("memory", repoName, ...rest) });
  }
  return out;
}

async function applyAndPush(
  repo: WorkspaceRepo,
  pod: PodMeta,
  tmp: string,
  mapped: { src: string; dest: string }[],
): Promise<ExportResult> {
  await repo.syncUnlocked();
  const changed: string[] = [];
  for (const { src, dest } of mapped) {
    const podText = await readFile(join(tmp, src), "utf8");
    const destPath = join(repo.dir, dest);
    const current = await readFile(destPath, "utf8").catch(() => undefined);
    const base = await repo.show(pod.workspaceSha, dest);
    const merged = await unionMerge(current, base, podText);
    if (merged !== current) {
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, merged);
      changed.push(dest);
    }
  }
  if (changed.length === 0) return { files: [] };
  await git(repo.dir, ["add", "--", ...changed]);
  await git(repo.dir, [
    "commit",
    "--quiet",
    "-m",
    `panem: export memory from ${pod.id}`,
    "-m",
    `Template: ${pod.template}\nMachine: ${pod.machine}\nRefs: ${pod.repos.map((r) => `${r.name}@${r.ref}`).join(", ")}`,
  ]);
  await git(repo.dir, ["push", "--quiet", "origin", `HEAD:${repo.branch}`]);
  return { files: changed, commit: await repo.headUnlocked() };
}

function isPushRace(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}\n${(e as { stderr?: string }).stderr ?? ""}` : "";
  return /rejected|fetch first|non-fast-forward/i.test(msg);
}
