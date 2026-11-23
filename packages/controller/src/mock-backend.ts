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
import { shq } from "./shell";

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
  /**
   * Stands in for each machine's sign-in volume: <loginsDir>/<machine>/<agent> exists once the
   * agent was signed in there (by interactiveArgv's mock sign-in).
   */
  readonly loginsDir = mkdtempSync(join(tmpdir(), "panem-mock-logins-"));
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
      // Agents already signed in on this machine start signed in, as with the shared volume.
      for (const a of JSON.parse(this.agentsJson) as { id: string; login?: unknown }[]) {
        if (a.login && this.isSignedIn(o.machine, a.id)) this.markRunning(o.id, a.id);
      }
    }
    this.events.push(`up:${o.id}`);
  }

  async list(): Promise<BackendPod[]> {
    return [...this.pods.values()].map((p) => ({
      id: p.id,
      machine: p.machine,
      status: p.status,
      uid: mockUid(p.id),
    }));
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
    // Restarting one agent (after a sign-in): it runs if its machine is signed in.
    const only = command.match(/^PANEM_ONLY_AGENT=([A-Za-z0-9_-]+) /)?.[1];
    if (only) {
      this.events.push(`restart:${only}:${id}`);
      if (this.isSignedIn(this.pod(id).machine, only)) this.markRunning(id, only);
      return { exitCode: 0, stdout: new Uint8Array(), stderr: "" };
    }
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

  isSignedIn(machine: string, agent: string): boolean {
    return existsSync(join(this.loginsDir, machine, agent));
  }

  private markRunning(id: string, agent: string) {
    const dir = join(this.home(id), ".panem/agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${agent}.status.json`),
      JSON.stringify({ id: agent, state: "running", message: "", at: new Date().toISOString() }),
    );
    writeFileSync(join(dir, `${agent}.login.json`), JSON.stringify({ shared: true }));
  }

  /**
   * A stand-in sign-in: prints a link, asks for a code, and on any non-empty code marks the
   * agent signed in on the pod's machine. Exits 1 without one.
   */
  interactiveArgv(id: string, command: string): { argv: string[]; env: Record<string, string> } {
    const agent = command.trim().split(/\s+/).at(-1) ?? "";
    const mark = join(this.loginsDir, this.pod(id).machine, agent);
    const script = [
      `printf 'Mock sign-in for %s in %s\\r\\nOpen https://example.com/mock-login and paste the code.\\r\\nCode: ' ${shq(agent)} ${shq(id)}`,
      "IFS= read -r code",
      `if [ -n "$code" ]; then mkdir -p ${shq(dirname(mark))} && touch ${shq(mark)} && printf 'Signed in.\\r\\n'; else printf 'No code entered.\\r\\n'; exit 1; fi`,
    ].join("; ");
    return { argv: ["bash", "-c", script], env: {} };
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
/** DevPod-style workspace uid for a mock pod. */
export const mockUid = (id: string) => `default-${id}`;
/** A stable small number per pod id, for varied mock figures. */
const seed = (id: string) => Number(BigInt(Bun.hash(id)) % 1_000_000n);
const shortId = (id: string) => Bun.hash(id).toString(16).padStart(12, "0").slice(0, 12);

/**
 * A machine shell for mock mode: answers the resource monitor's scripts from the mock pods,
 * and keeps Docker-in-Docker volumes per machine. Like DevPod, deleting a mock pod leaves its
 * volume behind; two volumes from "earlier" pods are there from the start.
 */
export class MockResourceShell {
  /** machine host -> volume name -> size */
  volumes = new Map<string, Map<string, number>>();

  constructor(private readonly backend: MockBackend) {}

  private vols(host: string) {
    let v = this.volumes.get(host);
    if (!v) {
      v = new Map([
        ["dind-var-lib-docker-default-old-a1b2c3", 3_400_000_000],
        ["dind-var-lib-docker-default-old-d4e5f6", 820_000_000],
      ]);
      this.volumes.set(host, v);
    }
    return v;
  }

  private podsOn(host: string) {
    const m = this.backend.machinesList.find((x) => x.host === host);
    return [...this.backend.pods.values()].filter((p) => p.machine === m?.name);
  }

  async run(m: { host: string }, argv: string[]) {
    const script = argv.at(-1) ?? "";
    const pods = this.podsOn(m.host);
    const vols = this.vols(m.host);
    for (const p of pods) {
      const v = `dind-var-lib-docker-${mockUid(p.id)}`;
      if (!vols.has(v)) vols.set(v, 600_000_000 + (seed(p.id) % 900) * 1_000_000);
    }
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const mounts = (p: { id: string }) =>
      `${shortId(p.id)}${"0".repeat(52)}\tbind||/workspaces/${p.id};volume|panem-logins|/var/lib/panem/logins;volume|dind-var-lib-docker-${mockUid(p.id)}|/var/lib/docker;`;
    if (script.includes("@@panem:mem")) {
      const running = pods.filter((p) => p.status === "running");
      return ok(
        [
          "@@panem:os",
          "Linux",
          "@@panem:mem",
          `MemTotal:       ${16 * 1024 * 1024} kB`,
          `MemAvailable:   ${Math.max(1, 11_900_000 - running.length * 700_000)} kB`,
          "@@panem:pods",
          ...running.map((p) => `${shortId(p.id)}\t${mockUid(p.id)}`),
          "@@panem:stats",
          ...running.map((p) => `${shortId(p.id)}\t${200 + (seed(p.id) % 600)}.4MiB / 15.5GiB`),
          "",
        ].join("\n"),
      );
    }
    if (script.includes("@@panem:volumes")) {
      const used = new Set(pods.map((p) => `dind-var-lib-docker-${mockUid(p.id)}`));
      return ok(
        [
          "@@panem:root",
          "/var/lib/docker",
          "@@panem:df",
          "Filesystem     1024-blocks      Used Available Capacity Mounted on",
          "/dev/nvme0n1p2   479595076 334507228 120654848      74% /",
          "@@panem:ps",
          ...pods.map(
            (p) =>
              `${shortId(p.id)}\t${mockUid(p.id)}\tvsc-example-1a2b3c:devpod\t${(1 + (seed(p.id) % 9) / 10).toFixed(2)}GB (virtual 3.13GB)`,
          ),
          "@@panem:mounts",
          ...pods.map(mounts),
          "@@panem:volumes",
          JSON.stringify(
            [...vols].map(([name, size]) => ({
              Name: name,
              Links: used.has(name) ? "1" : "0",
              Size: `${(size / 1e9).toFixed(2)}GB`,
            })),
          ),
          "",
        ].join("\n"),
      );
    }
    const uid = script.match(/label=dev\.containers\.id=(\S+?)\)/)?.[1];
    if (uid) {
      const p = pods.find((x) => mockUid(x.id) === uid);
      return ok(p ? `${mounts(p)}\n` : "");
    }
    const rm = script.match(/docker volume rm (\S+)/)?.[1];
    if (rm) {
      if (pods.some((p) => `dind-var-lib-docker-${mockUid(p.id)}` === rm)) return ok("in-use\n");
      vols.delete(rm);
      return ok("removed\n");
    }
    return { code: 1, stdout: "", stderr: "mock shell: unexpected command" };
  }
}

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
