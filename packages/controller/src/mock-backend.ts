import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BackendError,
  type BackendMachine,
  type BackendPod,
  type ExecResult,
  type FolderLock,
  type ForwarderState,
  type ForwarderStatus,
  PANEM_VERSION,
  type PodBackend,
  type UpOptions,
  claudeProjectDir,
  repoPath,
} from "@panem/core";

interface MockPod {
  id: string;
  machine: string;
  status: "running" | "stopped";
  env: Record<string, string>;
  /** A real folder standing in for the container: <dir>/home and <dir>/codebase. */
  dir: string;
}

type Op = "up" | "stop" | "start" | "delete" | "exec" | "upload" | "hook";

/**
 * PodBackend for tests and `PANEM_BACKEND=mock`. Each pod is a real temp folder with a fake
 * $HOME and code root, and exec/upload really run their commands there (with HOME and
 * PANEM_CODE_ROOT pointed at it), so the in-pod scripts are exercised for real.
 */
export class MockBackend implements PodBackend {
  pods = new Map<string, MockPod>();
  machinesList: BackendMachine[] = [];
  delayMs = 0;
  failNext: Partial<Record<Op, string>> = {};
  /** What happened, in order: "up:<id>", "upload:<id>", "hook:start:<id>", ... */
  events: string[] = [];
  /** What setup writes to ~/.panem/agents.json (undefined: none, like an older Feature). */
  agentsJson: string | undefined = JSON.stringify([
    {
      id: "claude-code",
      label: "Claude Code",
      connect: [{ label: "Open in Claude", url: "https://claude.ai/code" }],
    },
  ]);

  private async step(op: Op) {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    const f = this.failNext[op];
    if (f) {
      delete this.failNext[op];
      throw new BackendError(f);
    }
  }

  private pod(id: string): MockPod {
    const p = this.pods.get(id);
    if (!p) throw new BackendError(`workspace ${id} not found`);
    return p;
  }

  home(id: string): string {
    return join(this.pod(id).dir, "home");
  }

  codeRoot(id: string): string {
    return join(this.pod(id).dir, "codebase");
  }

  /** Stands in for /usr/local/share/panem/agents (agent hooks live here). */
  agentsDir(id: string): string {
    return join(this.pod(id).dir, "agents");
  }

  /** Test helper: install an agent hook in the pod. */
  writeAgentHook(id: string, agent: string, hook: string, script: string) {
    const dir = join(this.agentsDir(id), agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, hook), script, { mode: 0o755 });
  }

  /** The last `up` call, for tests (where DevPod would build from). */
  lastUp?: UpOptions;

  async up(o: UpOptions) {
    this.lastUp = o;
    // The build is the part that reads the workspace folder.
    await (o.withFolder ?? ((f) => f()))(() => this.step("up"));
    if (!this.machinesList.some((m) => m.name === o.machine)) {
      throw new BackendError(`provider ${o.machine} not found`);
    }
    const dir = mkdtempSync(join(tmpdir(), `panem-mockpod-${o.id}-`));
    const pod: MockPod = { id: o.id, machine: o.machine, status: "running", env: o.env, dir };
    this.pods.set(o.id, pod);
    // What post-create does: clone the repos (here: empty git repos) and write pod.json.
    const meta = JSON.parse(o.env.PANEM_POD ?? "{}") as { repos?: { name: string }[] };
    for (const r of meta.repos ?? []) {
      const repo = join(this.codeRoot(o.id), r.name);
      mkdirSync(repo, { recursive: true });
      Bun.spawnSync(["git", "init", "-q", repo]);
    }
    mkdirSync(join(this.home(o.id), ".panem"), { recursive: true });
    mkdirSync(this.agentsDir(o.id), { recursive: true });
    // Files the controller places before setup (git host keys, the git token file).
    for (const f of o.files ?? []) {
      const p = join(this.home(o.id), f.path.replace(/^~\//, ""));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, f.content, { mode: f.mode });
    }
    if (o.sshAuthSock) this.events.push(`agent:${o.id}`);
    writeFileSync(join(this.home(o.id), ".panem/pod.json"), o.env.PANEM_POD ?? "{}");
    if (this.agentsJson !== undefined) {
      writeFileSync(join(this.home(o.id), ".panem/agents.json"), this.agentsJson);
    }
    this.events.push(`up:${o.id}`);
  }

  async list(): Promise<BackendPod[]> {
    return [...this.pods.values()].map((p) => ({ id: p.id, machine: p.machine, status: p.status }));
  }

  async start(id: string, opts: { withFolder?: FolderLock } = {}) {
    await (opts.withFolder ?? ((f) => f()))(() => this.step("start"));
    this.pod(id).status = "running";
    this.events.push(`start:${id}`);
  }

  async stop(id: string) {
    await this.step("stop");
    this.pod(id).status = "stopped";
  }

  async delete(id: string, opts: { force?: boolean } = {}) {
    await this.step("delete");
    const p = this.pods.get(id);
    if (!p && !opts.force) return;
    if (p) rmSync(p.dir, { recursive: true, force: true });
    this.pods.delete(id);
  }

  private async run(id: string, command: string, stdin?: Uint8Array): Promise<ExecResult> {
    const p = this.pod(id);
    if (p.status !== "running") return fail("DevPod workspace is stopped");
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: this.home(id),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: this.home(id),
        PANEM_CODE_ROOT: this.codeRoot(id),
        PANEM_AGENTS_DIR: this.agentsDir(id),
      },
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** sshAuthSock each exec was given (by command kind), for tests. */
  execAgents: { id: string; kind: string; sshAuthSock?: string }[] = [];

  async exec(id: string, command: string, opts?: { sshAuthSock?: string }): Promise<ExecResult> {
    await this.step("exec");
    this.execAgents.push({
      id,
      kind: command.includes("panem-before-destroy") ? "before-destroy" : "other",
      sshAuthSock: opts?.sshAuthSock,
    });
    if (command.includes("panem-before-destroy")) this.events.push(`before-destroy:${id}`);
    if (command.includes("panem-export")) this.events.push(`save-memory:${id}`);
    return this.run(id, command);
  }

  async upload(id: string, data: Uint8Array, command: string): Promise<ExecResult> {
    await this.step("upload");
    this.events.push(`upload:${id}`);
    return this.run(id, command, data);
  }

  async runHook(id: string, hook: "start") {
    await this.step("hook");
    this.events.push(`hook:${hook}:${id}`);
  }

  /** Local path of a pod path ("~/..." or "/codebase/..."). */
  localPath(id: string, podPath: string): string {
    if (podPath.startsWith("~/")) return join(this.home(id), podPath.slice(2));
    if (podPath.startsWith("/codebase/")) return join(this.codeRoot(id), podPath.slice(10));
    throw new Error(`unexpected pod path ${podPath}`);
  }

  /** Test helper: write a file in the pod, as the agent would. */
  writePodFile(id: string, podPath: string, content: string | Uint8Array) {
    const p = this.localPath(id, podPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  readPodFile(id: string, podPath: string): string | undefined {
    const p = this.localPath(id, podPath);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  /** Test helper: simulate Claude writing memory inside a pod. */
  writeMemory(id: string, repo: string, file: string, content: string) {
    this.writePodFile(
      id,
      `~/.claude/projects/${claudeProjectDir(repoPath(repo))}/memory/${file}`,
      content,
    );
  }

  async addMachine(m: BackendMachine) {
    this.machinesList.push(m);
  }
  async removeMachine(name: string) {
    this.machinesList = this.machinesList.filter((m) => m.name !== name);
  }
  async listMachines() {
    return [...this.machinesList];
  }
}

function fail(stderr: string): ExecResult {
  return { exitCode: 1, stdout: new Uint8Array(), stderr };
}

/**
 * Fake forwarders for PANEM_BACKEND=mock: each running pod "listens" on its template's named
 * ports plus 5173, 8000 and 5432, and ports are published once switched on.
 */
export class MockForwarders {
  readonly enabled = true;
  private blocks = new Map<string, number>();
  private exposed = new Map<string, number[]>();
  constructor(private readonly backend: MockBackend) {}

  async linkHost(m: { host: string }) {
    return m.host;
  }

  async state(m: { name: string }): Promise<ForwarderState> {
    const pods = [...this.backend.pods.values()].filter((p) => p.machine === m.name);
    return {
      version: PANEM_VERSION,
      unplaced: [],
      pods: pods.map((p) => {
        if (!this.blocks.has(p.id)) this.blocks.set(p.id, 7600 + this.blocks.size * 10);
        const start = this.blocks.get(p.id)!;
        const meta = JSON.parse(p.env.PANEM_POD ?? "{}") as { ports?: Record<string, string> };
        const named = Object.keys(meta.ports ?? {}).map(Number);
        const exposed = this.exposed.get(p.id) ?? named;
        const running = p.status === "running";
        const listening = [5173, 8000, 5432, ...named];
        const all = [...new Set([...listening, ...exposed])].sort((a, b) => a - b);
        return {
          id: p.id,
          block: [start, start + 9] as [number, number],
          reachable: running,
          unmapped: [],
          ports: all.map((port) => {
            const slot = exposed.includes(port) ? exposed.indexOf(port) + 1 : undefined;
            return {
              podPort: port,
              name: meta.ports?.[String(port)],
              live: running && listening.includes(port),
              exposed: slot !== undefined,
              slot,
              hostPort: slot === undefined ? undefined : start + slot,
            };
          }),
        };
      }),
    };
  }

  async setExposed(_m: unknown, podId: string, ports: number[]) {
    this.exposed.set(
      podId,
      [...ports].sort((a, b) => a - b),
    );
  }

  async ensure(): Promise<ForwarderStatus> {
    return { status: "running", version: PANEM_VERSION };
  }
  async release(_m: unknown, podId: string) {
    this.blocks.delete(podId);
    this.exposed.delete(podId);
  }
  async remove() {}
}
