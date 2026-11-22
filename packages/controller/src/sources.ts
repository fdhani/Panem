import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type SyncSource, WORKSPACE_SOURCE } from "@panem/core";
import { GitRepo } from "./git";
import type { Workspace } from "./workspace";

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
 * Where synced files come from: the workspace folder, other git repos (cloned under
 * <data>/sources/<name>), or other folders on the controller host.
 */
export class Sources {
  private readonly repos = new Map<string, GitRepo>();

  constructor(private readonly o: { dataDir: string; workspace: Workspace; home?: string }) {}

  /** The git client for a git source, or undefined for a folder (incl. the workspace). */
  repo(name: string, spec: SyncSource | undefined): GitRepo | undefined {
    if (name === WORKSPACE_SOURCE || !spec || !("git" in spec)) return undefined;
    const key = `${name}\0${spec.git}\0${spec.ref}`;
    let r = this.repos.get(key);
    if (!r) {
      r = new GitRepo(join(this.o.dataDir, "sources", name), spec.git, spec.ref);
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
   * Files of a source: a git source at `commit` (or freshly pulled when omitted), a folder
   * (the workspace, or a dir source) as it is now. For git, the files are extracted to a temp
   * folder.
   */
  async checkout(name: string, spec: SyncSource | undefined, commit?: string): Promise<Checkout> {
    if (name === WORKSPACE_SOURCE)
      return { root: await this.o.workspace.dir(), done: async () => {} };
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
