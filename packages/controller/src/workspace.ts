import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PanemConfig, type WorkspaceHookName } from "@panem/core";
import { Mutex } from "./git";

export interface HookResult {
  /** False when panem.json defines no such hook. */
  ran: boolean;
  ok: boolean;
  /** Why it failed: exit code or timeout, plus the last lines of output. */
  error?: string;
}

/** The workspace can't be used: none is set yet, or its folder is gone. The API answers 409. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export const NO_WORKSPACE =
  "No workspace yet: run `panem workspace init` in a folder on the controller.";

/**
 * The workspace: a folder on the controller holding templates, panem.json, files to copy into
 * pods and saved agent memory. DevPod builds pods from it (uploading it to the machine).
 * Its path is read fresh on each use, so `panem workspace init` applies without a restart.
 */
export class Workspace {
  /** Serialises writes into the folder (saving memory). */
  readonly lock = new Mutex();

  constructor(
    private readonly path: () => Promise<string | undefined> | string | undefined,
    private readonly hookTimeoutMs = 120_000,
  ) {}

  /** The folder, or undefined when none is set. */
  async current(): Promise<string | undefined> {
    return (await this.path()) || undefined;
  }

  /** The folder; throws WorkspaceError when none is set, or if it's gone. */
  async dir(): Promise<string> {
    const d = await this.current();
    if (!d) throw new WorkspaceError(NO_WORKSPACE);
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      throw new WorkspaceError(
        `workspace folder ${d} is missing: restore it, or run \`panem workspace init\` elsewhere`,
      );
    }
    return d;
  }

  /** Run a workspace hook from panem.json, holding the lock (see runHookUnlocked). */
  runHook(name: WorkspaceHookName, env: Record<string, string> = {}): Promise<HookResult> {
    return this.lock.run(() => this.runHookUnlocked(name, env));
  }

  /**
   * Run a workspace hook from the folder's current panem.json: bash, in the folder, with the
   * controller's environment plus `env`, within the time limit. Caller holds the lock.
   */
  async runHookUnlocked(
    name: WorkspaceHookName,
    env: Record<string, string> = {},
  ): Promise<HookResult> {
    const dir = await this.dir();
    let cmd: string | undefined;
    try {
      const raw = JSON.parse(await readFile(join(dir, "panem.json"), "utf8"));
      cmd = PanemConfig.safeParse(raw).data?.hooks?.[name];
    } catch {
      return { ran: false, ok: true }; // no (or unreadable) panem.json: templates report it
    }
    if (!cmd) return { ran: false, ok: true };

    const p = Bun.spawn(["bash", "-c", cmd], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The hook's children too (e.g. a hung `git push`), then bash itself.
      Bun.spawnSync(["pkill", "-KILL", "-P", String(p.pid)]);
      p.kill("SIGKILL");
    }, this.hookTimeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    if (code === 0 && !timedOut) return { ran: true, ok: true };
    const tail = `${out}\n${err}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-5)
      .join(" | ");
    const why = timedOut
      ? `timed out after ${Math.round(this.hookTimeoutMs / 1000)}s`
      : `failed with exit ${code}`;
    return {
      ran: true,
      ok: false,
      error: `workspace hook ${name} ${why}${tail ? `: ${tail}` : ""}`,
    };
  }
}
