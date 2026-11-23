import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendMachine,
  BackendPod,
  ExecResult,
  PodBackend,
  PodFile,
  UpOptions,
} from "@panem/core";
import { BackendError, LEGACY_POD_STATE_DIR } from "@panem/core";
import { run, text } from "./run";

/** DevPod version this backend is tested against. Bump together with the CI integration test. */
export const DEVPOD_VERSION = "v0.6.15";

/** Where the claude-code Feature installs its hooks inside the pod. */
const HOOKS = "/usr/local/share/panem";
/**
 * First boot: the one-time setup, unless pod.json shows it already ran. The start hook runs
 * separately (runHook), after the controller has copied synced files in.
 */
export const BOOTSTRAP_CREATE = [
  // An image DevPod reused from an older build would run old setup scripts: say so plainly.
  'if [ -n "${PANEM_EXPECT_BUILD:-}" ]; then',
  `  got="$(cat ${HOOKS}/BUILD 2>/dev/null || true)";`,
  '  if [ "$got" != "$PANEM_EXPECT_BUILD" ]; then',
  '    echo "panem: this pod was built from a cached image with older Panem Features (build ${got:-none}, expected $PANEM_EXPECT_BUILD). Delete the image (docker image ls, look for vsc-*) and summon again." >&2; exit 1;',
  "  fi;",
  "fi;",
  `if [ -x ${HOOKS}/post-create.sh ]; then`,
  // pod.json marks setup as done: ~/.panem today, /workspace/.panem before the rename.
  `  if [ ! -f "$HOME/.panem/pod.json" ] && [ ! -f ${LEGACY_POD_STATE_DIR}/pod.json ]; then ${HOOKS}/post-create.sh || exit $?; fi;`,
  "fi",
].join(" ");
export const BOOTSTRAP_START = `if [ -x ${HOOKS}/post-start.sh ]; then ${HOOKS}/post-start.sh; fi`;

/** Exit code the stdin upload uses when fewer bytes arrived than were sent. */
export const STDIN_SHORT = 97;
/** Base64 characters per exec call in the chunked fallback (well under command-line limits). */
const UPLOAD_CHUNK = 48 * 1024;

/** Receive exactly `len` bytes on stdin into a temp file, then feed them to `command`. */
export function stdinUploadScript(len: number, command: string): string {
  return [
    't="$(mktemp)"',
    'cat > "$t"',
    `n="$(wc -c < "$t" | tr -d ' ')"`,
    `if [ "$n" != "${len}" ]; then rm -f "$t"; echo "panem: upload got $n of ${len} bytes" >&2; exit ${STDIN_SHORT}; fi`,
    `( ${command} ) < "$t"; rc=$?; rm -f "$t"; exit $rc`,
  ].join("; ");
}

/**
 * DevPod context options Panem needs (see README "Private repos"). By default DevPod adds every
 * private key in ~/.ssh to whatever agent it forwards, and forwards the controller's git
 * credential store to pods for any host. Panem gives pods scoped git access itself instead.
 */
export const CONTEXT_OPTIONS = {
  SSH_ADD_PRIVATE_KEYS: "false",
  SSH_INJECT_GIT_CREDENTIALS: "false",
} as const;

/** `devpod ssh` flags for every Panem session: no DevPod credential helper or port forwarding. */
const SSH_FLAGS = ["--start-services=false"];

/** Provider names the controller owns. Other DevPod providers are left alone. */
export const MACHINE_PREFIX = "m-";
/** Host value that registers the controller's own Docker daemon instead of an SSH host. */
export const LOCAL_HOST = "local";

export interface DevPodOptions {
  bin?: string;
  /** Where `devpod up` output (and pod setup output) is saved per pod, e.g. <data>/logs. */
  logDir?: string;
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
  private readonly logDir?: string;

  constructor(opts: DevPodOptions = {}) {
    this.logDir = opts.logDir;
    this.bin = opts.bin ?? "devpod";
    this.env = { DEVPOD_DISABLE_TELEMETRY: "true", ...opts.env };
    this.upTimeoutMs = opts.upTimeoutMs ?? 30 * 60_000;
    this.statusTimeoutMs = opts.statusTimeoutMs ?? 20_000;
  }

  /**
   * Every devpod call. SSH_AUTH_SOCK is blank unless Panem lends a scoped agent for this call,
   * so an agent in the controller's own environment is never forwarded into a pod.
   */
  private run(
    args: string[],
    timeoutMs?: number,
    check = true,
    stdin?: Uint8Array,
    sshAuthSock?: string,
  ) {
    return run(this.bin, args, {
      env: { ...this.env, SSH_AUTH_SOCK: sshAuthSock ?? "" },
      timeoutMs,
      check,
      stdin,
    });
  }

  /** Set the DevPod context options Panem relies on (idempotent; run once at startup). */
  async configureContext(): Promise<void> {
    await this.run([
      "context",
      "set-options",
      ...Object.entries(CONTEXT_OPTIONS).flatMap(([k, v]) => ["-o", `${k}=${v}`]),
    ]);
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
      // Local folders (tests, single-machine setups) take no @branch suffix.
      const local = /^(\/|\.\/|\.\.\/)/.test(o.source);
      const source = o.sourceRef && !local ? `${o.source}@${o.sourceRef}` : o.source;
      const res = await this.run(
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
          // Verbose output costs nothing unless something fails, and then it's what we need.
          "--debug",
        ],
        this.upTimeoutMs,
        false,
      );
      const out = clean(`${text(res.stdout)}\n${res.stderr}`, Object.values(o.env));
      await this.saveLog(o.id, "devpod up", out);
      if (res.exitCode !== 0) {
        const err = new BackendError(
          `devpod up failed: ${lastMeaningful(out)}`,
          res.stderr,
          res.exitCode,
        );
        err.detail = tail(out, 60);
        throw err;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Git host keys, aliases and the token file: in place before the clone runs.
    if (o.files?.length) await this.placeFiles(o.id, o.files);
    await this.lifecycle(o.id, "create", o.sshAuthSock);
  }

  /** Put files under the pod user's home, over stdin (never argv or env), keeping their modes. */
  private async placeFiles(id: string, files: PodFile[]): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "panem-files-"));
    try {
      for (const f of files) {
        if (!f.path.startsWith("~/") || f.path.includes("..")) {
          throw new BackendError(`pod file path must be under ~/: ${f.path}`);
        }
        const p = join(dir, f.path.slice(2));
        await mkdir(join(p, ".."), { recursive: true });
        await writeFile(p, f.content, { mode: f.mode });
        await chmod(p, f.mode);
      }
      const tar = Bun.spawnSync(["tar", "-czf", "-", "-C", dir, "."], { stderr: "pipe" });
      if (tar.exitCode !== 0) throw new BackendError(`packing pod files: ${tar.stderr}`);
      const r = await this.upload(
        id,
        tar.stdout,
        'umask 077; tar -xzpf - -C "$HOME" --no-same-owner --no-overwrite-dir',
      );
      if (r.exitCode !== 0) {
        throw new BackendError(`placing files in ${id} failed: ${r.stderr.trim()}`, r.stderr);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * DevPod (v0.6.x) doesn't run lifecycle hooks declared by devcontainer Features, so the
   * pod's setup never happens on its own. Run the Feature's hooks over SSH instead. They are
   * idempotent, so this is also safe where the hooks did run (e.g. the devcontainer CLI).
   * Pods built without the Feature are left alone.
   */
  private async lifecycle(
    id: string,
    phase: "create" | "start",
    sshAuthSock?: string,
  ): Promise<void> {
    const cmd = phase === "create" ? BOOTSTRAP_CREATE : BOOTSTRAP_START;
    const r = await this.run(
      ["ssh", id, ...SSH_FLAGS, "--command", cmd],
      15 * 60_000,
      false,
      undefined,
      sshAuthSock,
    );
    if (r.exitCode !== 0) {
      const out = clean(`${text(r.stdout)}\n${r.stderr}`);
      await this.saveLog(id, phase === "create" ? "pod setup" : "start hook", out, true);
      const err = new BackendError(
        `pod ${phase === "create" ? "setup" : "start hook"} failed: ${failureSummary(out)}`,
        r.stderr,
        r.exitCode,
      );
      err.detail = tail(out, 60);
      throw err;
    }
  }

  /** The saved output of a pod's `devpod up` (and setup, if it failed), or undefined. */
  async log(id: string): Promise<string | undefined> {
    if (!this.logDir) return undefined;
    return readFile(join(this.logDir, `${id}.log`), "utf8").catch(() => undefined);
  }

  /** Save a step's output for a pod, keeping only the newest logs. Never fails the caller. */
  private async saveLog(id: string, step: string, out: string, append = false): Promise<void> {
    const logDir = this.logDir;
    if (!logDir) return;
    try {
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      const body = `===== ${step} (${new Date().toISOString()}) =====\n${out}\n`;
      await (append ? appendFile : writeFile)(join(logDir, `${id}.log`), body, { mode: 0o600 });
      const logs = await Promise.all(
        (await readdir(logDir))
          .filter((f) => f.endsWith(".log"))
          .map(async (f) => ({ f, t: (await stat(join(logDir, f))).mtimeMs })),
      );
      for (const { f } of logs.sort((a, b) => b.t - a.t).slice(KEEP_LOGS)) {
        await rm(join(logDir, f), { force: true });
      }
    } catch {
      // A log we couldn't write is no reason to fail a pod.
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
    await this.lifecycle(id, "start");
  }

  async stop(id: string): Promise<void> {
    await this.run(["stop", id], 5 * 60_000);
  }

  async delete(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["delete", id, "--ignore-not-found"];
    if (opts.force) args.push("--force");
    await this.run(args, 10 * 60_000);
  }

  async exec(id: string, command: string, opts?: { sshAuthSock?: string }): Promise<ExecResult> {
    // Long enough for before-destroy hooks (each has its own, shorter limit in the pod).
    const res = await this.run(
      ["ssh", id, ...SSH_FLAGS, "--command", command],
      30 * 60_000,
      false,
      undefined,
      opts?.sshAuthSock,
    );
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  }

  async runHook(id: string, hook: "start"): Promise<void> {
    await this.lifecycle(id, hook);
  }

  /** Whether `devpod ssh --command` passes stdin through; learned on first upload. */
  private stdinWorks: boolean | undefined;

  /**
   * Pipe `data` into `command` in the pod. Tries stdin through `devpod ssh` first, with the byte
   * count checked in the pod. If the bytes don't arrive, falls back to base64 chunks sent over
   * ordinary exec calls, and remembers which way works.
   */
  async upload(id: string, data: Uint8Array, command: string): Promise<ExecResult> {
    if (this.stdinWorks !== false) {
      const res = await this.run(
        ["ssh", id, ...SSH_FLAGS, "--command", stdinUploadScript(data.length, command)],
        10 * 60_000,
        false,
        data,
      );
      if (res.exitCode !== STDIN_SHORT) {
        this.stdinWorks = true;
        return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
      }
      this.stdinWorks = false;
    }
    return this.chunkedUpload(id, data, command);
  }

  private async chunkedUpload(id: string, data: Uint8Array, command: string): Promise<ExecResult> {
    const tmp = `/tmp/panem-upload-${crypto.randomUUID()}`;
    const b64 = Buffer.from(data).toString("base64");
    const step = async (cmd: string) => {
      const r = await this.exec(id, cmd);
      if (r.exitCode !== 0) throw new BackendError(`upload to ${id} failed: ${r.stderr.trim()}`);
    };
    try {
      await step(`: > ${tmp}.b64`);
      for (let i = 0; i < b64.length; i += UPLOAD_CHUNK) {
        await step(`printf %s '${b64.slice(i, i + UPLOAD_CHUNK)}' >> ${tmp}.b64`);
      }
      return await this.exec(
        id,
        `base64 -d ${tmp}.b64 > ${tmp} && rm -f ${tmp}.b64 && { ( ${command} ) < ${tmp}; rc=$?; rm -f ${tmp}; exit $rc; }`,
      );
    } catch (e) {
      await this.exec(id, `rm -f ${tmp} ${tmp}.b64`).catch(() => {});
      throw e;
    }
  }

  /**
   * Registers a provider. DevPod only initializes a provider when it's "used", so we let
   * `provider add` do that (its default). It also becomes DevPod's default provider, which
   * doesn't matter: every call passes --provider explicitly.
   */
  async addMachine(m: BackendMachine): Promise<void> {
    if (!m.name.startsWith(MACHINE_PREFIX)) {
      throw new BackendError(`machine names must start with ${MACHINE_PREFIX}`);
    }
    if (m.host === LOCAL_HOST) {
      await this.run(["provider", "add", "docker", "--name", m.name]);
      return;
    }
    const target = m.user ? `${m.user}@${m.host}` : m.host;
    await this.run(["provider", "add", "ssh", "--name", m.name, "-o", `HOST=${target}`]);
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

/**
 * What to show when a pod's setup fails: the scripts' own "panem: …" lines when there are any
 * (e.g. which repo failed to clone, with git's message), else the last lines of output.
 */
export function failureSummary(out: string): string {
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const ours = lines.filter((l) => l.startsWith("panem: ")).map((l) => l.slice(7));
  return (ours.length ? ours.slice(-3) : lines.slice(-5)).join(" | ");
}

/** Saved `devpod up` logs kept per controller (newest first). */
export const KEEP_LOGS = 20;

/**
 * Output made readable and safe to keep: terminal escape codes and carriage-return redraws
 * removed, and any of `secrets` (e.g. the env values passed to the pod) replaced by ***.
 */
export function clean(s: string, secrets: string[] = []): string {
  let out = s
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape codes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n");
  for (const v of secrets) if (v.length >= 8) out = out.split(v).join("***");
  return out.trim();
}

/** Last n non-empty lines. */
export function tail(s: string, n: number): string[] {
  return s
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n);
}

/** The most useful single line: the last error-looking one, else the last line. */
function lastMeaningful(out: string): string {
  const lines = tail(out, 200);
  const err = [...lines].reverse().find((l) => /\b(error|fatal|failed)\b/i.test(l));
  return (err ?? lines.at(-1) ?? "unknown error").trim();
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
