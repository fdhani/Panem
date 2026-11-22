import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[], check = true): Promise<GitResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (check && code !== 0) {
    throw new GitError(`git ${args[0]} failed: ${stderr.trim().split("\n").at(-1)}`, stderr);
  }
  return { code, stdout, stderr };
}

/** Promise-chain mutex: everything touching the clone runs one at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

/**
 * The controller's clone of the workspace repo. It always mirrors origin/<branch>:
 * every sync hard-resets to the remote, so a failed export never leaves local state behind.
 */
export class WorkspaceRepo {
  readonly lock = new Mutex();
  private lastSync = 0;

  constructor(
    readonly dir: string,
    readonly url: string,
    readonly branch: string,
  ) {}

  /**
   * Fetch and reset to origin. Caller must hold the lock. Returns HEAD, or "" while the branch
   * has no commits yet (a brand-new, empty repo is a valid sync source: the first export
   * creates its first commit).
   */
  async syncUnlocked(): Promise<string> {
    if (!existsSync(`${this.dir}/.git`)) {
      await mkdir(dirname(this.dir), { recursive: true });
      const r = await git(
        dirname(this.dir),
        ["clone", "--branch", this.branch, "--", this.url, this.dir],
        false,
      );
      if (r.code !== 0) {
        if (!isMissingBranch(r.stderr))
          throw new GitError(`git clone failed: ${lastLine(r.stderr)}`, r.stderr);
        // Empty remote (or no such branch yet): start the branch locally.
        await rm(this.dir, { recursive: true, force: true });
        await git(dirname(this.dir), ["clone", "--", this.url, this.dir]);
        await git(this.dir, ["symbolic-ref", "HEAD", `refs/heads/${this.branch}`]);
      }
      await git(this.dir, ["config", "user.name", "panem"]);
      await git(this.dir, ["config", "user.email", "panem@localhost"]);
    } else {
      const f = await git(this.dir, ["fetch", "--quiet", "origin", this.branch], false);
      if (f.code === 0) {
        await git(this.dir, ["reset", "--quiet", "--hard", `origin/${this.branch}`]);
      } else if (!isMissingBranch(f.stderr)) {
        throw new GitError(`git fetch failed: ${lastLine(f.stderr)}`, f.stderr);
      } else if (await this.headUnlocked()) {
        // The branch vanished upstream: drop local commits too, to mirror the remote.
        await git(this.dir, ["checkout", "--quiet", "--orphan", `panem-empty-${Date.now()}`]);
        await git(this.dir, ["rm", "-rfq", "--cached", "."], false);
        await git(this.dir, ["branch", "-D", this.branch], false);
        await git(this.dir, ["checkout", "--quiet", "--orphan", this.branch]);
      }
      await git(this.dir, ["clean", "-fdq"]);
    }
    this.lastSync = Date.now();
    return this.headUnlocked();
  }

  /** Sync if the last sync is older than maxAgeMs. Returns HEAD. */
  sync(maxAgeMs = 0): Promise<string> {
    return this.lock.run(async () => {
      if (maxAgeMs > 0 && Date.now() - this.lastSync < maxAgeMs && existsSync(`${this.dir}/.git`)) {
        return this.headUnlocked();
      }
      return this.syncUnlocked();
    });
  }

  /** HEAD commit, or "" on a branch with no commits yet. */
  async headUnlocked(): Promise<string> {
    const r = await git(this.dir, ["rev-parse", "--verify", "--quiet", "HEAD"], false);
    return r.code === 0 ? r.stdout.trim() : "";
  }

  /** File bytes at a commit, or undefined if missing (or no commit). */
  async showBytes(sha: string, path: string): Promise<Uint8Array | undefined> {
    if (!sha) return undefined;
    const p = Bun.spawn(["git", "show", `${sha}:${path}`], {
      cwd: this.dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(p.stdout).bytes(), p.exited]);
    return code === 0 ? out : undefined;
  }

  /** File contents at a commit, or undefined if missing (or commit unknown). */
  async show(sha: string, path: string): Promise<string | undefined> {
    if (!sha) return undefined;
    const r = await git(this.dir, ["show", `${sha}:${path}`], false);
    return r.code === 0 ? r.stdout : undefined;
  }
}

function isMissingBranch(stderr: string): boolean {
  return /not found in upstream|couldn't find remote ref|Remote branch .* not found|empty repository/i.test(
    stderr,
  );
}

function lastLine(s: string): string {
  return s.trim().split("\n").at(-1) ?? "";
}
