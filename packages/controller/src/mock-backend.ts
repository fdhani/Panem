import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BackendError,
  type BackendMachine,
  type BackendPod,
  type ExecResult,
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
  /** Files under ~/.claude/projects, keyed by relative path. */
  files: Map<string, string>;
}

/**
 * In-memory PodBackend for tests and `PANEM_BACKEND=mock` UI development.
 * `exec` understands the export command and returns a real base64 tarball.
 */
export class MockBackend implements PodBackend {
  pods = new Map<string, MockPod>();
  machinesList: BackendMachine[] = [];
  delayMs = 0;
  failNext: Partial<Record<"up" | "stop" | "start" | "delete" | "exec", string>> = {};

  private async step(op: keyof MockBackend["failNext"]) {
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

  async up(o: UpOptions) {
    await this.step("up");
    if (!this.machinesList.some((m) => m.name === o.machine)) {
      throw new BackendError(`provider ${o.machine} not found`);
    }
    const files = new Map<string, string>();
    const meta = JSON.parse(o.env.PANEM_POD ?? "{}") as { repos?: { name: string }[] };
    for (const r of meta.repos ?? []) {
      files.set(`${claudeProjectDir(repoPath(r.name))}/memory/MEMORY.md`, "");
    }
    this.pods.set(o.id, { id: o.id, machine: o.machine, status: "running", env: o.env, files });
  }

  async list(): Promise<BackendPod[]> {
    return [...this.pods.values()].map((p) => ({ id: p.id, machine: p.machine, status: p.status }));
  }

  async start(id: string) {
    await this.step("start");
    this.pod(id).status = "running";
  }

  async stop(id: string) {
    await this.step("stop");
    this.pod(id).status = "stopped";
  }

  async delete(id: string, opts: { force?: boolean } = {}) {
    await this.step("delete");
    if (!this.pods.has(id) && !opts.force) return;
    this.pods.delete(id);
  }

  async exec(id: string, command: string): Promise<ExecResult> {
    await this.step("exec");
    const p = this.pod(id);
    if (p.status !== "running") return fail("DevPod workspace is stopped");
    if (command.startsWith("cat /workspace/.panem/pod.json")) {
      return { exitCode: 0, stdout: new TextEncoder().encode(p.env.PANEM_POD ?? "{}"), stderr: "" };
    }
    if (!command.includes("memory")) return fail(`mock: unsupported command ${command}`);
    const files = [...p.files].filter(([, v]) => v !== "");
    if (files.length === 0) return { exitCode: 0, stdout: new Uint8Array(), stderr: "" };
    const dir = await mkdtemp(join(tmpdir(), "panem-mock-"));
    try {
      for (const [rel, content] of files) {
        await mkdir(dirname(join(dir, rel)), { recursive: true });
        await writeFile(join(dir, rel), content);
      }
      const tar = Bun.spawn(["tar", "-czf", "-", "-C", dir, ...files.map(([rel]) => `./${rel}`)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const bytes = await new Response(tar.stdout).bytes();
      if ((await tar.exited) !== 0) return fail(await new Response(tar.stderr).text());
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(Buffer.from(bytes).toString("base64")),
        stderr: "",
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Test helper: simulate Claude writing memory inside a pod. */
  writeMemory(id: string, repo: string, file: string, content: string) {
    this.pod(id).files.set(`${claudeProjectDir(repoPath(repo))}/memory/${file}`, content);
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

/** Fake forwarders for PANEM_BACKEND=mock: running pods get a block and two demo services. */
export class MockForwarders {
  readonly enabled = true;
  private blocks = new Map<string, number>();
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
        const declared = Object.entries(meta.ports ?? { 5173: "web", 8000: "api" });
        const running = p.status === "running";
        return {
          id: p.id,
          block: [start, start + 9] as [number, number],
          reachable: running,
          unmapped: [],
          ports: declared.map(([port, name], i) => ({
            slot: i + 1,
            hostPort: start + i + 1,
            podPort: Number(port),
            name,
            live: running,
          })),
        };
      }),
    };
  }

  async ensure(): Promise<ForwarderStatus> {
    return { status: "running", version: PANEM_VERSION };
  }
  async release(_m: unknown, podId: string) {
    this.blocks.delete(podId);
  }
  async remove() {}
}
