import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type SyncSource, WORKSPACE_SOURCE } from "@panem/core";
import { WorkspaceRepo } from "./git";

/** A source's files on the controller, ready to read. */
export interface Checkout {
  /** Folder holding the source's files (a temp extract for git, the folder itself for dir). */
  root: string;
  /** Git sources: the commit these files are from ("" for a repo with no commits yet). */
  commit?: string;
  /** Remove temp files (never touches a dir source's own folder). */
  done(): Promise<void>;
}

/**
 * Where synced files come from: the workspace repo, other git repos (cloned under
 * <data>/sources/<name>), or folders on the controller host.
 */
export class Sources {
  private readonly repos = new Map<string, WorkspaceRepo>();

  constructor(private readonly o: { dataDir: string; workspace: WorkspaceRepo; home?: string }) {}

  /** The git client for a source, or undefined for a dir source. */
  repo(name: string, spec: SyncSource | undefined): WorkspaceRepo | undefined {
    if (name === WORKSPACE_SOURCE) return this.o.workspace;
    if (!spec || !("git" in spec)) return undefined;
    const key = `${name}\0${spec.git}\0${spec.ref}`;
    let r = this.repos.get(key);
    if (!r) {
      r = new WorkspaceRepo(join(this.o.dataDir, "sources", name), spec.git, spec.ref);
      this.repos.set(key, r);
    }
    return r;
  }

  /** Absolute folder of a dir source ("~" is the controller user's home). */
  dir(spec: { dir: string }): string {
    const home = this.o.home ?? homedir();
    return spec.dir === "~" ? home : spec.dir.replace(/^~\//, `${home}/`);
  }

  /**
   * Files of a source: a git source at `commit` (or freshly pulled when omitted), a dir source
   * as it is now. For git, the files are extracted to a temp folder.
   */
  async checkout(name: string, spec: SyncSource | undefined, commit?: string): Promise<Checkout> {
    const repo = this.repo(name, spec);
    if (!repo) {
      const root = this.dir(spec as { dir: string });
      if (!existsSync(root)) throw new Error(`source "${name}": folder ${root} does not exist`);
      return { root, done: async () => {} };
    }
    const tmp = await mkdtemp(join(tmpdir(), `panem-src-${name}-`));
    try {
      const sha = await repo.lock.run(async () => {
        const head = commit ?? (await repo.syncUnlocked());
        if (head) await archive(repo.dir, head, tmp);
        return head;
      });
      return { root: tmp, commit: sha, done: () => rm(tmp, { recursive: true, force: true }) };
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw new Error(`source "${name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  snapshotPath(podId: string, name: string): string {
    return join(this.o.dataDir, "snapshots", podId, `${name}.tgz`);
  }

  /** Keep a copy of the dir-source files sent to a pod: the merge base on export. */
  async saveSnapshot(podId: string, name: string, root: string, files: string[]): Promise<string> {
    const path = this.snapshotPath(podId, name);
    await mkdir(dirname(path), { recursive: true });
    const list = join(dirname(path), `${name}.list`);
    await writeFile(list, files.map((f) => `${f}\0`).join(""));
    try {
      await sh(["tar", "--null", "-czf", path, "-C", root, "-T", list]);
    } finally {
      await rm(list, { force: true });
    }
    return path;
  }

  /** Read one file from a snapshot (undefined if it wasn't in it, or the snapshot is gone). */
  async snapshotReader(
    path: string,
  ): Promise<{ read(p: string): Promise<Uint8Array | undefined>; done(): Promise<void> }> {
    const tmp = await mkdtemp(join(tmpdir(), "panem-snap-"));
    if (existsSync(path)) await sh(["tar", "-xzf", path, "-C", tmp]);
    return {
      read: async (p) =>
        existsSync(join(tmp, p)) ? new Uint8Array(await readFile(join(tmp, p))) : undefined,
      done: () => rm(tmp, { recursive: true, force: true }),
    };
  }

  async removeSnapshots(podId: string): Promise<void> {
    await rm(join(this.o.dataDir, "snapshots", podId), { recursive: true, force: true });
  }
}

/** Every file under `root`, relative and with "/" separators. Skips .git folders. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  if (existsSync(root)) await walk(root);
  return out.sort();
}

async function archive(repoDir: string, commit: string, dest: string): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error(`bad commit ${commit}`);
  const p = Bun.spawn(
    [
      "sh",
      "-c",
      'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
      "sh",
      repoDir,
      commit,
      dest,
    ],
    {
      stderr: "pipe",
    },
  );
  if ((await p.exited) !== 0)
    throw new Error(`git archive: ${await new Response(p.stderr).text()}`);
}

async function sh(argv: string[]): Promise<void> {
  const p = Bun.spawn(argv, { stderr: "pipe", stdout: "ignore" });
  if ((await p.exited) !== 0) throw new Error(`${argv[0]}: ${await new Response(p.stderr).text()}`);
}
