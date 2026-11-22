import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type PodBackend, type PodMeta, WORKSPACE_SOURCE, expandRules, mapIn } from "@panem/core";
import { APPLY_SYNC_SCRIPT, bashCommand } from "./pod/scripts";
import { type Sources, listFiles } from "./sources";

/** "~/x" -> "home/x", "/codebase/api/x" -> "codebase/api/x": where a file sits in the upload. */
export function stagePath(podPath: string): string {
  if (podPath.startsWith("~/")) return `home/${podPath.slice(2)}`;
  if (podPath.startsWith("/codebase/")) return `codebase/${podPath.slice("/codebase/".length)}`;
  throw new Error(`unexpected pod path ${podPath}`);
}

export interface SyncInResult {
  /** The workspace repo commit that was sent (the pod's workspaceSha: memory's merge base). */
  workspaceSha: string;
  files: number;
  /** Warnings from the pod (e.g. overlay files skipped because the repo tracks them). */
  notes: string[];
}

/**
 * Copy a pod's synced files from every source into the pod, in one upload, and record which
 * workspace-repo commit was sent (memory's merge base when it's saved back on delete).
 * Runs after the pod's one-time setup and before its start hook launches the agent.
 */
export async function syncIn(
  d: { backend: PodBackend; sources: Sources },
  pod: PodMeta,
): Promise<SyncInResult> {
  const sync = pod.sync;
  if (!sync) throw new Error(`pod ${pod.id} has no sync rules`);
  const rules = expandRules(
    sync.rules,
    pod.repos.map((r) => r.name),
  );
  const names = [...new Set(rules.map((r) => r.source))];
  const stage = await mkdtemp(join(tmpdir(), "panem-sync-in-"));
  let workspaceSha = pod.workspaceSha;
  let files = 0;
  try {
    for (const name of names) {
      const spec = name === WORKSPACE_SOURCE ? undefined : sync.sources[name];
      const commit = name === WORKSPACE_SOURCE && pod.workspaceSha ? pod.workspaceSha : undefined;
      const co = await d.sources.checkout(name, spec, commit);
      try {
        const all = await listFiles(co.root);
        for (const m of mapIn(rules, name, all, sync.exclude)) {
          const dest = join(stage, stagePath(m.dest));
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(join(co.root, m.src), dest);
          files++;
        }
        if (name === WORKSPACE_SOURCE && co.commit) workspaceSha = co.commit;
      } finally {
        await co.done();
      }
    }

    // Refresh the pod's own copy of its metadata (used by `panem rediscover`).
    const podJson = join(stage, "home/.panem/pod.json");
    await mkdir(dirname(podJson), { recursive: true });
    await writeFile(podJson, `${JSON.stringify({ ...pod, workspaceSha }, null, 2)}\n`);

    const tar = Bun.spawn(["tar", "-czf", "-", "-C", stage, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [bytes, code] = await Promise.all([new Response(tar.stdout).bytes(), tar.exited]);
    if (code !== 0)
      throw new Error(`packing synced files: ${await new Response(tar.stderr).text()}`);

    const r = await d.backend.upload(
      pod.id,
      bytes,
      bashCommand(APPLY_SYNC_SCRIPT, "panem-apply-sync"),
    );
    const notes = r.stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("panem:"));
    if (r.exitCode !== 0) {
      throw new Error(
        `copying synced files into the pod failed: ${r.stderr.trim().split("\n").at(-1)}`,
      );
    }
    return { workspaceSha, files, notes };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
