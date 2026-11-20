import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

  /** Fetch and reset to origin. Caller must hold the lock. */
  async syncUnlocked(): Promise<string> {
    if (!existsSync(`${this.dir}/.git`)) {
      await mkdir(dirname(this.dir), { recursive: true });
      await git(dirname(this.dir), ["clone", "--branch", this.branch, "--", this.url, this.dir]);
      await git(this.dir, ["config", "user.name", "panem"]);
      await git(this.dir, ["config", "user.email", "panem@localhost"]);
    } else {
      await git(this.dir, ["fetch", "--quiet", "origin", this.branch]);
      await git(this.dir, ["reset", "--quiet", "--hard", `origin/${this.branch}`]);
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

  async headUnlocked(): Promise<string> {
    return (await git(this.dir, ["rev-parse", "HEAD"])).stdout.trim();
  }

  /** File contents at a commit, or undefined if missing (or commit unknown). */
  async show(sha: string, path: string): Promise<string | undefined> {
    if (!sha) return undefined;
    const r = await git(this.dir, ["show", `${sha}:${path}`], false);
    return r.code === 0 ? r.stdout : undefined;
  }
}
