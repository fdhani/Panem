import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PanemConfig, type WorkspaceHookName } from "@panem/core";
import { derivedConfig } from "./devcontainer-config";
import { Mutex } from "./git";
import { featuresHash, panemFeatures } from "./machine-assets";

/** One Docker volume per machine for agents' shared sign-ins (agent.json "login.share"). */
export const LOGINS_MOUNT = {
  source: "panem-logins",
  target: "/var/lib/panem/logins",
  type: "volume",
};

/** Whether any of these shipped agents keeps its sign-in in the machine's volume. */
async function sharesLogins(ids: string[]): Promise<boolean> {
  for (const f of await panemFeatures()) {
    const m = /^([^/]+)\/agent\/agent\.json$/.exec(f.path);
    if (!m || !ids.includes(m[1]!)) continue;
    try {
      const a = JSON.parse(new TextDecoder().decode(f.data)) as { login?: { share?: string[] } };
      if (a.login?.share?.length) return true;
    } catch {
      // not ours to judge here
    }
  }
  return false;
}

/** Folder next to a template's devcontainer.json where Panem keeps its Features up to date. */
export const FEATURES_DIR = "panem-features";

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

  /**
   * Put Panem's devcontainer Features (the running version) next to a template's
   * devcontainer.json, in panem-features/<id>/, so templates can list "./panem-features/<id>"
   * and DevPod uploads them with the workspace: no registry. Writes only what changed and
   * removes files older versions left behind. A .gitignore keeps them out of a git-backed
   * workspace (DevPod only honours .devpodignore, so they're still uploaded).
   */
  async installFeatures(devcontainerPath: string): Promise<{ written: number }> {
    return this.lock.run(async () => {
      const root = resolve(await this.dir());
      const dir = resolve(root, dirname(devcontainerPath), FEATURES_DIR);
      if (!dir.startsWith(root + sep)) throw new Error("devcontainer path escapes the workspace");
      const files = await panemFeatures();
      const wanted = new Set(files.map((f) => f.path));
      let written = 0;
      for (const f of files) {
        const dest = join(dir, f.path);
        const same = await readFile(dest).then(
          (b) => Buffer.from(b).equals(Buffer.from(f.data)),
          () => false,
        );
        if (!same) {
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, f.data);
          written++;
        }
        await chmod(dest, f.exec ? 0o755 : 0o644);
      }
      const existing = existsSync(dir)
        ? await readdir(dir, { recursive: true, withFileTypes: true })
        : [];
      for (const e of existing) {
        if (!e.isFile()) continue;
        const rel = relative(dir, join(e.parentPath, e.name)).split(sep).join("/");
        if (rel !== ".gitignore" && !wanted.has(rel)) await rm(join(dir, rel), { force: true });
      }
      const ignore = join(dir, ".gitignore");
      if (!existsSync(ignore)) {
        await writeFile(ignore, "# Written by Panem at each summon (its own Features).\n*\n");
      }
      return { written };
    });
  }

  /**
   * Make a template ready for DevPod: put Panem's Features in place and, when the template
   * lists them, write the config DevPod should use (see derivedConfig) next to them. Returns
   * that config's path (relative to the workspace) and the build it expects in the pod, or the
   * template's own path when it doesn't use Panem's Features.
   */
  async prepareDevcontainer(devcontainerPath: string): Promise<{ path: string; build?: string }> {
    await this.installFeatures(devcontainerPath);
    return this.lock.run(async () => {
      const root = resolve(await this.dir());
      const raw = await readFile(join(root, devcontainerPath), "utf8").catch(() => undefined);
      if (raw === undefined) return { path: devcontainerPath };
      const build = await featuresHash();
      let derived: ReturnType<typeof derivedConfig>;
      try {
        derived = derivedConfig(raw, build);
        // Agents that keep their sign-in per machine get the machine's login volume, once.
        if (derived && (await sharesLogins(derived.ids))) {
          derived = derivedConfig(raw, build, { mounts: [LOGINS_MOUNT] });
        }
      } catch (e) {
        throw new WorkspaceError(`${devcontainerPath}: not valid JSON: ${(e as Error).message}`);
      }
      if (!derived) return { path: devcontainerPath };
      const path = join(dirname(devcontainerPath), FEATURES_DIR, "devcontainer.json");
      await writeFile(join(root, path), derived.json);
      return { path, build };
    });
  }
}
