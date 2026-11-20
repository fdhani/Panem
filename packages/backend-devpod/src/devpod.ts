import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendMachine, BackendPod, ExecResult, PodBackend, UpOptions } from "@panem/core";
import { BackendError } from "@panem/core";
import { run, text } from "./run";

/** DevPod version this backend is tested against. Bump together with the CI integration test. */
export const DEVPOD_VERSION = "v0.6.15";

/** Provider names the controller owns. Other DevPod providers are left alone. */
export const MACHINE_PREFIX = "m-";
/** Host value that registers the controller's own Docker daemon instead of an SSH host. */
export const LOCAL_HOST = "local";

export interface DevPodOptions {
  bin?: string;
  /** Extra env for every devpod call (e.g. DEVPOD_HOME in tests). */
  env?: Record<string, string>;
  upTimeoutMs?: number;
  statusTimeoutMs?: number;
}

export class DevPodBackend implements PodBackend {
  private readonly bin: string;
  private readonly env: Record<string, string>;
  private readonly upTimeoutMs: number;
  private readonly statusTimeoutMs: number;

  constructor(opts: DevPodOptions = {}) {
    this.bin = opts.bin ?? "devpod";
    this.env = { DEVPOD_DISABLE_TELEMETRY: "true", ...opts.env };
    this.upTimeoutMs = opts.upTimeoutMs ?? 30 * 60_000;
    this.statusTimeoutMs = opts.statusTimeoutMs ?? 20_000;
  }

  private run(args: string[], timeoutMs?: number, check = true) {
    return run(this.bin, args, { env: this.env, timeoutMs, check });
  }

  /** Returns the installed version and whether it matches the pinned one. */
  async version(): Promise<{ version: string; pinned: boolean }> {
    const out = text((await this.run(["version"])).stdout).trim();
    const version = out.match(/v?\d+\.\d+\.\d+\S*/)?.[0] ?? out;
    const norm = (v: string) => v.replace(/^v/, "");
    return { version, pinned: norm(version) === norm(DEVPOD_VERSION) };
  }

  async up(o: UpOptions): Promise<void> {
    // Secrets go through an env file (0600), never argv, so they don't show up in `ps`.
    const dir = await mkdtemp(join(tmpdir(), "panem-up-"));
    const envFile = join(dir, "workspace.env");
    try {
      const lines = Object.entries(o.env).map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new BackendError(`invalid env name ${k}`);
        if (v.includes("\n")) throw new BackendError(`env ${k} contains a newline`);
        return `${k}=${v}`;
      });
      await writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
      const source = o.sourceRef ? `${o.source}@${o.sourceRef}` : o.source;
      await this.run(
        [
          "up",
          source,
          "--id",
          o.id,
          "--provider",
          o.machine,
          "--ide",
          "none",
          "--open-ide=false",
          "--devcontainer-path",
          o.devcontainerPath,
          "--workspace-env-file",
          envFile,
        ],
        this.upTimeoutMs,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async list(): Promise<BackendPod[]> {
    const raw = text((await this.run(["list", "--output", "json"])).stdout).trim();
    const entries = parseList(raw);
    return Promise.all(
      entries.map(async (e) => ({
        id: e.id,
        machine: e.provider,
        status: await this.status(e.id),
      })),
    );
  }

  async status(id: string): Promise<BackendPod["status"]> {
    try {
      const res = await this.run(["status", id, "--output", "json"], this.statusTimeoutMs, false);
      if (res.exitCode !== 0) return "unknown";
      return parseStatus(text(res.stdout));
    } catch {
      return "unknown";
    }
  }

  async start(id: string): Promise<void> {
    // `devpod up <id>` starts a stopped workspace; `devpod ssh` does not.
    await this.run(["up", id, "--ide", "none", "--open-ide=false"], this.upTimeoutMs);
  }

  async stop(id: string): Promise<void> {
    await this.run(["stop", id], 5 * 60_000);
  }

  async delete(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["delete", id, "--ignore-not-found"];
    if (opts.force) args.push("--force");
    await this.run(args, 10 * 60_000);
  }

  async exec(id: string, command: string): Promise<ExecResult> {
    const res = await this.run(["ssh", id, "--command", command], 10 * 60_000, false);
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  }

  async addMachine(m: BackendMachine): Promise<void> {
    if (!m.name.startsWith(MACHINE_PREFIX)) {
      throw new BackendError(`machine names must start with ${MACHINE_PREFIX}`);
    }
    if (m.host === LOCAL_HOST) {
      await this.run(["provider", "add", "docker", "--name", m.name, "--use=false"]);
      return;
    }
    const target = m.user ? `${m.user}@${m.host}` : m.host;
    await this.run([
      "provider",
      "add",
      "ssh",
      "--name",
      m.name,
      "--use=false",
      "-o",
      `HOST=${target}`,
    ]);
  }

  async removeMachine(name: string): Promise<void> {
    if (!name.startsWith(MACHINE_PREFIX)) throw new BackendError(`not a panem machine: ${name}`);
    await this.run(["provider", "delete", name]);
  }

  async listMachines(): Promise<BackendMachine[]> {
    const raw = text((await this.run(["provider", "list", "--output", "json"])).stdout);
    return parseProviders(raw);
  }
}

// ---- parsers (exported for tests; DevPod JSON shapes are not a stable API) ----

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parseList(raw: string): { id: string; provider: string }[] {
  if (!raw) return [];
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new BackendError("unexpected devpod list output");
  return arr
    .map((e) => {
      const o = obj(e);
      const provider = str(obj(o.provider).name) ?? str(o.provider) ?? "";
      return { id: str(o.id) ?? "", provider };
    })
    .filter((e) => e.id && e.provider.startsWith(MACHINE_PREFIX));
}

export function parseStatus(raw: string): BackendPod["status"] {
  let state = "";
  try {
    state = str(obj(JSON.parse(raw)).state) ?? "";
  } catch {
    state = raw.trim();
  }
  switch (state.toLowerCase()) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "busy":
      return "busy";
    case "notfound":
      return "notfound";
    default:
      return "unknown";
  }
}

export function parseProviders(raw: string): BackendMachine[] {
  const map = obj(JSON.parse(raw || "{}"));
  const out: BackendMachine[] = [];
  for (const [name, entry] of Object.entries(map)) {
    if (!name.startsWith(MACHINE_PREFIX)) continue;
    const e = obj(entry);
    const options = obj(obj(e.state).options ?? e.options);
    const hostOpt = options.HOST;
    const target = str(obj(hostOpt).value) ?? str(hostOpt);
    if (!target) {
      out.push({ name, host: LOCAL_HOST });
      continue;
    }
    const at = target.lastIndexOf("@");
    out.push(
      at >= 0
        ? { name, host: target.slice(at + 1), user: target.slice(0, at) }
        : { name, host: target },
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
