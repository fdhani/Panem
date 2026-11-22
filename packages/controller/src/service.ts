import {
  type AddMachineRequest,
  AgentInfo,
  type BackendPod,
  DEFAULT_TEMPLATE_ENV,
  type ForwarderState,
  type ForwarderStatus,
  type Job,
  LEGACY_AGENTS,
  type Machine,
  type MachineStatus,
  PANEM_VERSION,
  type Pod,
  type PodBackend,
  PodMeta,
  type PodState,
  READ_POD_JSON,
  type ServerEvent,
  type SummonRequest,
  devcontainerPathFor,
  machineProviderName,
  newPodId,
  resolveRefs,
  resolveSync,
} from "@panem/core";
import { z } from "zod";
import { exportPod } from "./exporter";
import type { Forwarders, MachineRef } from "./forwarders";
import type { WorkspaceRepo } from "./git";
import { BEFORE_DESTROY_SCRIPT, bashCommand } from "./pod/scripts";
import type { HostProbe } from "./probe";
import type { Sources } from "./sources";
import type { JobStore, PodStore } from "./stores";
import { syncIn } from "./sync-in";
import type { Templates } from "./templates";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 502,
    message: string,
  ) {
    super(message);
  }
}

interface Op {
  state: PodState;
  error?: string;
}

export interface ServiceDeps {
  backend: PodBackend;
  repo: WorkspaceRepo;
  templates: Templates;
  pods: PodStore;
  jobs: JobStore;
  probe: HostProbe;
  /** Agent credentials by env var name, read fresh at each summon (so `panem env set` applies). */
  credentials?: () => Promise<Record<string, string>> | Record<string, string>;
  relaySecret?: string;
  forwarders?: Forwarders;
  sources: Sources;
  /** Time limit for each before-destroy hook, in seconds (default 600). */
  hookTimeoutSec?: number;
  log?: (msg: string) => void;
}

interface FwdInfo {
  status: ForwarderStatus;
  state?: ForwarderState;
  linkHost?: string;
}

/** How long to wait before automatically redeploying a forwarder that isn't answering. */
const AUTO_REPAIR_MS = 5 * 60_000;

/**
 * All controller behaviour. HTTP is a thin layer on top of this.
 * Pod state = in-flight controller operation if any, otherwise what the backend reports.
 */
export class PodService {
  private readonly ops = new Map<string, Op>();
  private readonly lastStatus = new Map<string, BackendPod["status"]>();
  private machineCache: Machine[] = [];
  private backendPods: BackendPod[] = [];
  private readonly listeners = new Set<(e: ServerEvent) => void>();
  private lastSent = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private fwd = new Map<string, FwdInfo>();
  /** True once backend.list() has succeeded, so "unknown pod" really means gone. */
  private backendListed = false;
  private lastRepair = new Map<string, number>();
  private readonly log: (msg: string) => void;

  constructor(private readonly d: ServiceDeps) {
    this.log = d.log ?? ((m) => console.log(`[panem] ${m}`));
  }

  // ---------- events ----------

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ServerEvent, force = false) {
    const key = e.type;
    const body = JSON.stringify(e);
    if (!force && this.lastSent.get(key) === body) return;
    this.lastSent.set(key, body);
    for (const l of this.listeners) l(e);
  }

  snapshot(): ServerEvent[] {
    return [
      { type: "machines", machines: this.machineCache },
      { type: "pods", pods: this.podList() },
      { type: "jobs", jobs: this.d.jobs.all() },
    ];
  }

  private publishPods() {
    this.emit({ type: "pods", pods: this.podList() });
    this.emit({ type: "jobs", jobs: this.d.jobs.all() });
  }

  private setOp(id: string, op: Op | undefined) {
    if (op) this.ops.set(id, op);
    else this.ops.delete(id);
    this.publishPods();
  }

  /** Refresh machines and pods from the backend. Called by the poller. */
  async refresh(): Promise<void> {
    await this.refreshMachines();
    try {
      this.backendPods = await this.d.backend.list();
      this.backendListed = true;
      for (const p of this.backendPods) {
        if (p.status !== "unknown") this.lastStatus.set(p.id, p.status);
      }
    } catch (e) {
      this.log(`backend list failed: ${msg(e)}`);
    }
    this.publishPods();
  }

  // ---------- machines ----------

  async refreshMachines(): Promise<Machine[]> {
    const ms = await this.d.backend.listMachines();
    const st = await this.d.probe.status(ms);
    const statuses = ms.map((m) => ({ ...m, status: st.get(m.host) ?? "unknown" }) as Machine);
    await Promise.all(
      statuses.filter((m) => m.status !== "offline").map((m) => this.pollForwarder(m)),
    );
    this.machineCache = statuses.map((m) => ({ ...m, forwarder: this.fwd.get(m.name)?.status }));
    this.emit({ type: "machines", machines: this.machineCache });
    return this.machineCache;
  }

  /** One GET /state per machine; a forwarder that stops answering is redeployed now and then. */
  private async pollForwarder(m: MachineRef) {
    const f = this.d.forwarders;
    if (!f?.enabled) {
      if (f) this.fwd.set(m.name, { status: { status: "disabled" } });
      return;
    }
    try {
      const state = await f.state(m);
      const status: ForwarderStatus = {
        status: state.version === PANEM_VERSION ? "running" : "outdated",
        version: state.version,
      };
      this.fwd.set(m.name, { status, state, linkHost: await f.linkHost(m) });
      if (status.status === "outdated") void this.autoRepair(m);
      // Push the user's port switches where the forwarder disagrees (missed update, redeploy).
      for (const p of state.pods) {
        const meta = this.d.pods.get(p.id);
        if (!meta?.exposePorts) continue;
        const want = this.desiredExposure(meta).join(",");
        const have = p.ports
          .filter((x) => x.exposed)
          .map((x) => x.podPort)
          .sort((a, b) => a - b)
          .join(",");
        if (want !== have) {
          await f
            .setExposed(m, p.id, this.desiredExposure(meta))
            .catch((e) => this.log(`sync exposed ports of ${p.id}: ${msg(e)}`));
        }
      }
      // Blocks held for pods that no longer exist (e.g. force-deleted while offline).
      if (this.backendListed) {
        for (const p of state.pods) {
          const known = this.d.pods.get(p.id) || this.backendPods.some((b) => b.id === p.id);
          if (!known) {
            this.log(`releasing ports of vanished pod ${p.id} on ${m.name}`);
            await f.release(m, p.id).catch(() => {});
          }
        }
      }
    } catch (e) {
      const prev = this.fwd.get(m.name);
      this.fwd.set(m.name, {
        status:
          prev?.status.status === "error" ? prev.status : { status: "missing", error: msg(e) },
      });
      void this.autoRepair(m);
    }
  }

  private async autoRepair(m: MachineRef) {
    const last = this.lastRepair.get(m.name) ?? 0;
    if (Date.now() - last < AUTO_REPAIR_MS) return;
    this.lastRepair.set(m.name, Date.now());
    try {
      await this.repairMachine(m.name, m);
    } catch {
      // status already records the error
    }
  }

  /** Deploy (or redeploy) the machine's forwarder. */
  async repairMachine(name: string, ref?: MachineRef): Promise<ForwarderStatus> {
    const f = this.d.forwarders;
    if (!f?.enabled)
      throw new HttpError(409, "port forwarding is not configured (run `panem init --force`)");
    const m = ref ?? (await this.d.backend.listMachines()).find((x) => x.name === name);
    if (!m) throw new HttpError(404, `machine ${name} not registered`);
    this.lastRepair.set(m.name, Date.now());
    try {
      const status = await f.ensure(m);
      this.fwd.set(m.name, { ...this.fwd.get(m.name), status });
      this.log(`forwarder on ${m.name}: ${status.status}`);
      return status;
    } catch (e) {
      const status: ForwarderStatus = { status: "error", error: msg(e) };
      this.fwd.set(m.name, { ...this.fwd.get(m.name), status });
      this.log(`forwarder on ${m.name} failed: ${msg(e)}`);
      throw new HttpError(502, msg(e));
    } finally {
      this.machineCache = this.machineCache.map((x) =>
        x.name === m.name ? { ...x, forwarder: this.fwd.get(m.name)?.status } : x,
      );
      this.emit({ type: "machines", machines: this.machineCache });
    }
  }

  machines(): Machine[] {
    return this.machineCache;
  }

  private machineStatus(name: string): MachineStatus {
    return this.machineCache.find((m) => m.name === name)?.status ?? "unknown";
  }

  async addMachine(req: AddMachineRequest): Promise<Machine> {
    const name = machineProviderName(req.host);
    if ((await this.d.backend.listMachines()).some((m) => m.name === name)) {
      throw new HttpError(409, `machine ${name} already registered`);
    }
    await this.d.backend.addMachine({ name, host: req.host, user: req.user });
    if (this.d.forwarders?.enabled) {
      // Deploy errors show on the machine (with Repair); they don't fail the add.
      await this.repairMachine(name, { name, host: req.host, user: req.user }).catch(() => {});
    }
    const ms = await this.refreshMachines();
    return ms.find((m) => m.name === name)!;
  }

  async removeMachine(name: string): Promise<void> {
    if (this.podList().some((p) => p.machine === name)) {
      throw new HttpError(409, `machine ${name} still has pods`);
    }
    const m = (await this.d.backend.listMachines()).find((x) => x.name === name);
    if (m && this.d.forwarders?.enabled) {
      await this.d.forwarders.remove(m).catch((e) => this.log(`forwarder removal: ${msg(e)}`));
    }
    this.fwd.delete(name);
    await this.d.backend.removeMachine(name);
    await this.refreshMachines();
  }

  // ---------- pods ----------

  podList(): Pod[] {
    const metas = new Map(this.d.pods.all().map((p) => [p.id, p]));
    // Pods DevPod knows about but the cache doesn't (e.g. lost pods.json) still show up.
    for (const b of this.backendPods) {
      if (!metas.has(b.id)) {
        metas.set(b.id, {
          id: b.id,
          template: b.id.replace(/-[a-z0-9]{6}$/, ""),
          machine: b.machine,
          repos: [],
          workspaceSha: "",
          createdAt: "",
        });
      }
    }
    return [...metas.values()]
      .map((m) => this.toPod(m))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Ports switched on: the user's choice, else the template's named ports. */
  private desiredExposure(meta: PodMeta): number[] {
    return [...(meta.exposePorts ?? Object.keys(meta.ports ?? {}).map(Number))].sort(
      (a, b) => a - b,
    );
  }

  /** The pod's ports with their switch and link, from its machine's forwarder state. */
  private servicesFor(meta: PodMeta): Pick<Pod, "services" | "indexUrl"> {
    const info = this.fwd.get(meta.machine);
    const p = info?.state?.pods.find((x) => x.id === meta.id);
    const want = new Set(this.desiredExposure(meta));
    const host = info?.linkHost;
    const byPort = new Map((p?.ports ?? []).map((x) => [x.podPort, x]));
    // Ports the forwarder hasn't reported yet (pod still starting) still show their switch.
    for (const port of [...want, ...Object.keys(meta.ports ?? {}).map(Number)]) {
      if (!byPort.has(port)) {
        byPort.set(port, {
          podPort: port,
          name: meta.ports?.[String(port)],
          live: false,
          exposed: false,
        });
      }
    }
    const services = [...byPort.values()]
      .sort((a, b) => a.podPort - b.podPort)
      .map((x) => ({
        podPort: x.podPort,
        name: x.name ?? meta.ports?.[String(x.podPort)],
        live: x.live,
        // The switch shows the user's choice; a link appears once the forwarder published it.
        exposed: want.has(x.podPort),
        hostPort: want.has(x.podPort) ? x.hostPort : undefined,
        url:
          want.has(x.podPort) && x.hostPort !== undefined && host
            ? `http://${host}:${x.hostPort}`
            : undefined,
      }));
    return {
      services,
      indexUrl: p && host && want.size ? `http://${host}:${p.block[0]}` : undefined,
    };
  }

  /** Switch one pod port on or off. Stored with the pod, then pushed to its forwarder. */
  async setPortExposure(id: string, port: number, exposed: boolean): Promise<Pod> {
    const meta = this.d.pods.get(id);
    if (!meta) throw new HttpError(404, `pod ${id} not found`);
    const f = this.d.forwarders;
    if (!f?.enabled) {
      throw new HttpError(409, "port forwarding is not configured (run `panem init --force`)");
    }
    const current = new Set(this.desiredExposure(meta));
    if (exposed) current.add(port);
    else current.delete(port);
    const next = { ...meta, exposePorts: [...current].sort((a, b) => a - b) };
    await this.d.pods.put(next);
    this.publishPods();
    const machine = this.machineCache.find((m) => m.name === meta.machine);
    if (machine && machine.status !== "offline") {
      try {
        await f.setExposed(machine, id, next.exposePorts);
        await this.pollForwarder(machine);
      } catch (e) {
        // Saved anyway: the next poll retries. Tell the caller it isn't live yet.
        this.log(`expose ${id}:${port} on ${machine.name}: ${msg(e)}`);
        throw new HttpError(502, `saved, but the forwarder didn't accept it yet: ${msg(e)}`);
      } finally {
        this.publishPods();
      }
    }
    return this.get(id);
  }

  private toPod(meta: PodMeta): Pod {
    const op = this.ops.get(meta.id);
    const machineStatus = this.machineStatus(meta.machine);
    const ports = {
      ...this.servicesFor(meta),
      // Pods from before agents were pluggable always had Claude Code.
      agents: meta.agents ?? LEGACY_AGENTS,
    };
    if (op) return { ...meta, ...ports, state: op.state, error: op.error, machineStatus };
    const job = this.d.jobs.forPod(meta.id);
    if (job?.status === "failed") {
      return { ...meta, ...ports, state: "error", error: job.error, machineStatus };
    }
    const b = this.backendPods.find((p) => p.id === meta.id);
    const status = b?.status === "unknown" ? this.lastStatus.get(meta.id) : b?.status;
    let state: PodState;
    let error: string | undefined;
    switch (status) {
      case "running":
        state = "running";
        break;
      case "busy":
        state = "starting";
        break;
      case "notfound":
        state = "error";
        error = "pod not found on machine";
        break;
      case undefined:
        // Not listed by the backend yet (or machine unreachable before first status).
        state = b ? "stopped" : "error";
        if (!b) error = "pod not known to backend";
        break;
      default:
        state = "stopped";
    }
    return { ...meta, ...ports, state, error, machineStatus };
  }

  get(id: string): Pod {
    const p = this.podList().find((x) => x.id === id);
    if (!p) throw new HttpError(404, `pod ${id} not found`);
    return p;
  }

  async summon(req: SummonRequest): Promise<Pod> {
    const { template, panem } = await this.d.templates.getWithConfig(req.template);
    if (!template) throw new HttpError(404, `template ${req.template} not found`);
    let sync: PodMeta["sync"];
    try {
      sync = resolveSync(panem, template);
    } catch (e) {
      throw new HttpError(400, msg(e));
    }
    const machines = await this.refreshMachines();
    const machine = machines.find((m) => m.name === req.machine);
    if (!machine) throw new HttpError(404, `machine ${req.machine} not registered`);
    if (machine.status === "offline") throw new HttpError(409, `machine ${req.machine} is offline`);
    let repos: PodMeta["repos"];
    try {
      repos = resolveRefs(template, req.refs);
    } catch (e) {
      throw new HttpError(400, msg(e));
    }
    const workspaceSha = await this.d.repo.sync();
    const meta = PodMeta.parse({
      id: newPodId(template.name),
      template: template.name,
      machine: machine.name,
      repos,
      workspaceSha,
      createdAt: new Date().toISOString(),
      ports: template.ports,
      ignorePorts: template.ignorePorts,
      exposePorts: Object.keys(template.ports ?? {})
        .map(Number)
        .sort((a, b) => a - b),
      sync,
      hooks: template.hooks,
    });
    await this.d.pods.put(meta);
    this.setOp(meta.id, { state: "creating" });

    const env: Record<string, string> = { PANEM_POD: JSON.stringify(meta) };
    // Only the credentials this template opted in to (default: the Claude token, as before).
    const creds = (await this.d.credentials?.()) ?? {};
    const wanted = template.env ?? DEFAULT_TEMPLATE_ENV;
    for (const name of wanted) {
      if (creds[name]) env[name] = creds[name];
      else this.log(`${meta.id}: template ${template.name} wants ${name}, which isn't configured`);
    }
    env.PANEM_AGENT_ENV = wanted.join(",");
    if (this.d.relaySecret) env.PANEM_RELAY_SECRET = this.d.relaySecret;
    void this.d.backend
      .up({
        id: meta.id,
        machine: machine.name,
        source: this.d.repo.url,
        sourceRef: this.d.repo.branch,
        devcontainerPath: devcontainerPathFor(template),
        env,
      })
      // Setup has run; place synced files before the start hook launches the agent.
      .then(() => this.syncIntoPod(meta))
      .then(() => this.d.backend.runHook(meta.id, "start"))
      .then(() => this.recordAgents(meta.id))
      .then(
        () => {
          this.lastStatus.set(meta.id, "running");
          this.upsertBackend({ id: meta.id, machine: machine.name, status: "running" });
          this.setOp(meta.id, undefined);
          this.log(`pod ${meta.id} is up on ${machine.name}`);
        },
        (e) => {
          this.log(`pod ${meta.id} failed to start: ${msg(e)}`);
          this.setOp(meta.id, { state: "error", error: msg(e) });
        },
      );
    return this.get(meta.id);
  }

  /**
   * Agents' before-destroy.sh, then the template's beforeDestroy command, in the pod. They push
   * whatever else should outlive it (e.g. overlay work) straight to its repo. A failure stops
   * the delete and keeps the pod (Retry, or Delete without saving).
   */
  private async runBeforeDestroy(meta: PodMeta): Promise<void> {
    const r = await this.d.backend.exec(
      meta.id,
      bashCommand(BEFORE_DESTROY_SCRIPT, "panem-before-destroy", [
        this.d.hookTimeoutSec ?? 600,
        meta.hooks?.beforeDestroy ?? "",
      ]),
    );
    if (r.exitCode !== 0) {
      const lines = r.stderr.trim().split("\n").filter(Boolean);
      const reason = lines.at(-1)?.replace(/^panem: /, "") ?? "before-destroy hook failed";
      const output = lines.slice(-6, -1).join(" | ");
      throw new Error(output ? `${reason}: ${output}` : reason);
    }
  }

  /** Which agents the pod has and how to reach them (~/.panem/agents.json, from the base). */
  private async recordAgents(id: string): Promise<void> {
    const r = await this.d.backend.exec(id, `cat "$HOME/.panem/agents.json"`);
    if (r.exitCode !== 0) return; // a Feature from before agents were pluggable: see toPod
    try {
      const agents = z.array(AgentInfo).parse(JSON.parse(new TextDecoder().decode(r.stdout)));
      const current = this.d.pods.get(id);
      if (current) await this.d.pods.put({ ...current, agents });
    } catch (e) {
      this.log(`${id}: unreadable agents.json: ${msg(e)}`);
    }
  }

  /** Copy synced files in and record what was sent (the export's merge bases). */
  private async syncIntoPod(meta: PodMeta): Promise<void> {
    const r = await syncIn({ backend: this.d.backend, sources: this.d.sources }, meta);
    const current = this.d.pods.get(meta.id) ?? meta;
    await this.d.pods.put({ ...current, workspaceSha: r.workspaceSha });
    for (const n of r.notes) this.log(`${meta.id}: ${n}`);
    this.log(`synced ${r.files} file(s) into ${meta.id}`);
  }

  private upsertBackend(p: BackendPod) {
    this.backendPods = [...this.backendPods.filter((x) => x.id !== p.id), p];
  }

  private assertIdle(id: string): Pod {
    const pod = this.get(id);
    const op = this.ops.get(id);
    if (op && op.state !== "error") throw new HttpError(409, `pod ${id} is busy (${op.state})`);
    return pod;
  }

  async stop(id: string): Promise<Pod> {
    const pod = this.assertIdle(id);
    if (pod.machineStatus === "offline") throw new HttpError(409, "machine is offline");
    await this.runOp(id, "stopping", () => this.d.backend.stop(id), "stopped");
    return this.get(id);
  }

  async start(id: string): Promise<Pod> {
    const pod = this.assertIdle(id);
    if (pod.machineStatus === "offline") throw new HttpError(409, "machine is offline");
    await this.runOp(id, "starting", () => this.d.backend.start(id), "running");
    return this.get(id);
  }

  /** Long-running ops return immediately; progress arrives over SSE. */
  private async runOp(
    id: string,
    state: PodState,
    fn: () => Promise<void>,
    done: BackendPod["status"],
  ) {
    this.setOp(id, { state });
    void fn().then(
      () => {
        this.lastStatus.set(id, done);
        const meta = this.d.pods.get(id);
        this.upsertBackend({ id, machine: meta?.machine ?? "", status: done });
        this.setOp(id, undefined);
      },
      (e) => this.setOp(id, { state: "error", error: msg(e) }),
    );
  }

  /**
   * Delete = export memory, then remove. Offline machines block delete unless forced;
   * force skips export and discards the pod's memory.
   */
  async delete(id: string, force = false): Promise<Pod | undefined> {
    const pod = this.get(id);
    const op = this.ops.get(id);
    if (op && op.state !== "error" && !force) {
      throw new HttpError(409, `pod ${id} is busy (${op.state})`);
    }
    if (force) {
      await this.d.backend.delete(id, { force: true });
      await this.forget(id);
      return undefined;
    }
    if (pod.machineStatus === "offline") {
      throw new HttpError(
        409,
        "machine is offline, so memory can't be saved. Delete without saving to discard it.",
      );
    }
    const existing = this.d.jobs.forPod(id);
    const now = new Date().toISOString();
    const job: Job = existing
      ? { ...existing, status: "pending", error: undefined, updatedAt: now }
      : {
          id: `job-${id}-${Date.now()}`,
          kind: "export-delete",
          podId: id,
          status: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        };
    await this.d.jobs.put(job);
    this.setOp(id, { state: "exporting" });
    this.enqueue(job.id);
    return this.get(id);
  }

  retryExport(id: string): Promise<Pod | undefined> {
    const job = this.d.jobs.forPod(id);
    if (!job || job.status !== "failed") throw new HttpError(409, "no failed export for this pod");
    return this.delete(id);
  }

  private async forget(id: string) {
    // Free the pod's port block on its machine (best effort: the machine may be gone).
    const meta = this.d.pods.get(id) ?? this.podList().find((p) => p.id === id);
    const machine = meta && this.machineCache.find((m) => m.name === meta.machine);
    if (machine && this.d.forwarders?.enabled) {
      await this.d.forwarders
        .release(machine, id)
        .catch((e) => this.log(`release ports of ${id}: ${msg(e)}`));
      const st = this.fwd.get(machine.name)?.state;
      if (st) st.pods = st.pods.filter((p) => p.id !== id);
    }
    const job = this.d.jobs.forPod(id);
    if (job) await this.d.jobs.remove(job.id);
    await this.d.pods.remove(id);
    this.backendPods = this.backendPods.filter((p) => p.id !== id);
    this.lastStatus.delete(id);
    this.setOp(id, undefined);
  }

  /** Resume jobs left pending or running by a previous controller process. */
  async resumeJobs(): Promise<void> {
    for (const j of this.d.jobs.all()) {
      if (j.status === "pending" || j.status === "running") {
        await this.d.jobs.put({ ...j, status: "pending" });
        this.ops.set(j.podId, { state: "exporting" });
        this.enqueue(j.id);
      }
    }
  }

  /** Exports run strictly one at a time. */
  private enqueue(jobId: string) {
    this.queue = this.queue.then(() => this.runJob(jobId)).catch(() => {});
  }

  /** Resolves when every queued job has finished (for tests and shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async runJob(jobId: string): Promise<void> {
    let job = this.d.jobs.get(jobId);
    if (!job || job.status === "done") return;
    const meta = this.d.pods.get(job.podId);
    const update = async (patch: Partial<Job>) => {
      job = { ...job!, ...patch, updatedAt: new Date().toISOString() };
      await this.d.jobs.put(job);
    };
    await update({ status: "running", attempts: job.attempts + 1 });
    try {
      if (meta) {
        // devpod ssh doesn't start stopped pods.
        const status = await this.backendStatus(meta.id);
        if (status === "stopped") {
          this.setOp(meta.id, { state: "starting" });
          await this.d.backend.start(meta.id);
        }
        this.setOp(meta.id, { state: "exporting" });
        await this.runBeforeDestroy(meta);
        const r = await exportPod({ backend: this.d.backend, repo: this.d.repo }, meta);
        for (const n of r.notes) this.log(`${meta.id}: ${n}`);
        this.log(
          r.files.length
            ? `saved ${r.files.length} memory file(s) from ${meta.id} (${r.commit?.slice(0, 8)})`
            : `no memory changes in ${meta.id}`,
        );
      }
      this.setOp(job.podId, { state: "deleting" });
      await this.d.backend.delete(job.podId);
      await update({ status: "done" });
      await this.forget(job.podId);
    } catch (e) {
      this.log(`export/delete of ${job.podId} failed: ${msg(e)}`);
      await update({ status: "failed", error: msg(e) });
      this.setOp(job.podId, undefined);
    }
  }

  private async backendStatus(id: string): Promise<BackendPod["status"]> {
    try {
      const list = await this.d.backend.list();
      return list.find((p) => p.id === id)?.status ?? "notfound";
    } catch {
      return "unknown";
    }
  }

  /** Rebuild the metadata cache from pods' own pod.json files. */
  async rediscover(): Promise<{ found: string[]; failed: string[] }> {
    const list = await this.d.backend.list();
    const found: string[] = [];
    const failed: string[] = [];
    for (const b of list) {
      if (this.d.pods.get(b.id)) continue;
      try {
        if (b.status !== "running") throw new Error("not running");
        const r = await this.d.backend.exec(b.id, READ_POD_JSON);
        if (r.exitCode !== 0) throw new Error(r.stderr);
        const meta = PodMeta.parse({
          ...JSON.parse(new TextDecoder().decode(r.stdout)),
          machine: b.machine,
        });
        await this.d.pods.put(meta);
        found.push(b.id);
      } catch {
        failed.push(b.id);
      }
    }
    await this.refresh();
    return { found, failed };
  }
}

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
