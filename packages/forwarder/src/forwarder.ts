import { type ForwarderPodState, type ForwarderState, PANEM_VERSION } from "@panem/core";
import type { Server, TCPSocketListener } from "bun";
import type { Allocator } from "./alloc";
import type { ContainerInfo, DockerApi } from "./docker";
import { listenPort } from "./proxy";
import { parseList, relayAsk } from "./relay";

interface PodMetaLite {
  id: string;
  ports?: Record<string, string>;
  ignorePorts?: number[];
}

interface LivePod {
  meta: PodMetaLite;
  containerId: string;
  ip: string;
  reachable: boolean;
  live: number[];
  unmapped: number[];
}

export interface ForwarderOptions {
  docker: DockerApi;
  alloc: Allocator;
  secret: string;
  blockSize: number;
  /** Address data listeners bind to inside the forwarder (0.0.0.0 in its container). */
  bindHost: string;
  relayPort: number;
  /** The forwarder's own container id, when running in Docker (joins pod networks). */
  selfId?: string;
  log?: (m: string) => void;
}

const NOT_A_POD_RETRY_MS = 30_000;

/**
 * One per machine. Finds pods by asking each running container's relay for its pod.json,
 * gives each pod a block of host ports, and proxies each slot to the pod port behind it.
 */
export class Forwarder {
  private pods = new Map<string, LivePod>();
  /** Last metadata seen per pod id, so stopped pods still have port names. */
  private metaById = new Map<string, PodMetaLite>();
  /** container id -> pod meta, or the time it was last found not to be a pod. */
  private probed = new Map<string, PodMetaLite | number>();
  private listeners = new Map<number, TCPSocketListener<unknown> | Server<unknown>>();
  private joined = new Set<string>();
  private unplaced: string[] = [];
  private readonly log: (m: string) => void;

  constructor(private readonly o: ForwarderOptions) {
    this.log = o.log ?? ((m) => console.log(`[forwarder] ${m}`));
  }

  async tick(): Promise<void> {
    const containers = (await this.o.docker.running()).filter(
      (c) => !this.o.selfId || !c.id.startsWith(this.o.selfId),
    );
    await this.joinNetworks(containers);
    const seen = new Map<string, LivePod>();
    await Promise.all(
      containers.map(async (c) => {
        const ip = this.ipFor(c);
        if (!ip) return;
        const meta = await this.probe(c, ip);
        if (!meta) return;
        let live: number[] = [];
        let reachable = true;
        try {
          const ignore = new Set([...(meta.ignorePorts ?? []), this.o.relayPort]);
          live = parseList(
            await relayAsk({ ip, port: this.o.relayPort }, this.o.secret, "list"),
          ).filter((p) => !ignore.has(p));
        } catch {
          reachable = false;
        }
        seen.set(meta.id, { meta, containerId: c.id, ip, reachable, live, unmapped: [] });
      }),
    );
    this.pods = seen;

    this.unplaced = [];
    for (const p of seen.values()) {
      this.metaById.set(p.meta.id, p.meta);
      if (this.o.alloc.block(p.meta.id) === undefined) {
        this.unplaced.push(p.meta.id);
        continue;
      }
      const declared = Object.keys(p.meta.ports ?? {}).map(Number);
      p.unmapped = this.o.alloc.assign(p.meta.id, declared, p.live);
    }
    await this.o.alloc.save();
    this.syncListeners();
  }

  /** Prefer an address on a network we share (always true on the default bridge). */
  private ipFor(c: ContainerInfo): string | undefined {
    return [...c.networks.values()][0];
  }

  private async probe(c: ContainerInfo, ip: string): Promise<PodMetaLite | undefined> {
    const cached = this.probed.get(c.id);
    if (typeof cached === "object") return cached;
    if (typeof cached === "number" && Date.now() - cached < NOT_A_POD_RETRY_MS) return undefined;
    try {
      const raw = await relayAsk({ ip, port: this.o.relayPort }, this.o.secret, "meta", 1000);
      const meta = JSON.parse(raw) as PodMetaLite;
      if (typeof meta.id !== "string" || !meta.id) throw new Error("no id");
      this.probed.set(c.id, meta);
      this.log(`found pod ${meta.id} in ${c.name || c.id.slice(0, 12)} (${ip})`);
      return meta;
    } catch {
      this.probed.set(c.id, Date.now());
      return undefined;
    }
  }

  /**
   * Pods on custom Docker networks are only routable if we're on that network too.
   * Only networks of devcontainer-looking containers are joined.
   */
  private async joinNetworks(containers: ContainerInfo[]) {
    if (!this.o.selfId) return;
    for (const c of containers) {
      const devcontainer = Object.keys(c.labels).some(
        (k) => k.startsWith("dev.containers") || k.startsWith("devpod"),
      );
      if (!devcontainer) continue;
      for (const net of c.networks.keys()) {
        if (this.joined.has(net)) continue;
        this.joined.add(net);
        try {
          await this.o.docker.connectNetwork(net, this.o.selfId);
          this.log(`joined network ${net.slice(0, 12)}`);
        } catch (e) {
          // Already connected is the common case.
          if (!String(e).includes("already exists")) this.log(`join ${net.slice(0, 12)}: ${e}`);
        }
      }
    }
  }

  /** Open a listener for every slot of every reachable pod; close everything else. */
  private syncListeners() {
    const want = new Map<number, () => TCPSocketListener<unknown> | Server<unknown>>();
    for (const p of this.pods.values()) {
      if (!p.reachable) continue;
      const block = this.o.alloc.peek(p.meta.id);
      if (block === undefined) continue;
      want.set(block, () => this.indexServer(block, p.meta.id));
      for (const s of this.o.alloc.slots(p.meta.id)) {
        want.set(
          s.hostPort,
          () =>
            listenPort({
              hostname: this.o.bindHost,
              port: s.hostPort,
              route: (hp) => this.route(hp),
              secret: this.o.secret,
              relayPort: this.o.relayPort,
            }) as TCPSocketListener<unknown>,
        );
      }
    }
    for (const [port, l] of this.listeners) {
      if (!want.has(port)) {
        l.stop(true);
        this.listeners.delete(port);
      }
    }
    for (const [port, open] of want) {
      if (this.listeners.has(port)) continue;
      try {
        this.listeners.set(port, open());
      } catch (e) {
        this.log(`cannot listen on ${port}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Resolve a host port to the pod behind it, at connect time. */
  route(hostPort: number): { ip: string; podPort: number } | undefined {
    for (const p of this.pods.values()) {
      if (!p.reachable) continue;
      const s = this.o.alloc.slots(p.meta.id).find((x) => x.hostPort === hostPort);
      if (s) return { ip: p.ip, podPort: s.podPort };
    }
    return undefined;
  }

  private indexServer(port: number, podId: string): Server<unknown> {
    return Bun.serve({
      hostname: this.o.bindHost,
      port,
      fetch: (req) => {
        const host = new URL(req.url).hostname;
        const pod = this.state().pods.find((p) => p.id === podId);
        const rows = (pod?.ports ?? [])
          .map((s) => {
            const url = `http://${host.includes(":") ? `[${host}]` : host}:${s.hostPort}`;
            const label = esc(s.name ?? `port ${s.podPort}`);
            return `<li><a href="${url}">${label}</a> <code>:${s.podPort} → ${s.hostPort}</code>${s.live ? "" : " <em>(not listening)</em>"}</li>`;
          })
          .join("");
        return new Response(
          `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(podId)}</title><style>body{font:16px system-ui;margin:24px;max-width:40em}li{margin:.5em 0}code{color:#666}em{color:#b45309}</style><h1>${esc(podId)}</h1><ul>${rows || "<li>No services yet</li>"}</ul>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
  }

  state(): ForwarderState {
    const ids = new Set([...this.o.alloc.ids(), ...this.pods.keys()]);
    const pods: ForwarderPodState[] = [];
    for (const id of ids) {
      const start = this.o.alloc.peek(id);
      if (start === undefined) continue;
      const live = this.pods.get(id);
      const meta = live?.meta ?? this.metaById.get(id);
      pods.push({
        id,
        block: [start, start + this.o.blockSize - 1],
        reachable: live?.reachable ?? false,
        ports: this.o.alloc.slots(id).map((s) => ({
          ...s,
          name: meta?.ports?.[String(s.podPort)],
          live: live?.reachable === true && live.live.includes(s.podPort),
        })),
        unmapped: live?.unmapped ?? [],
      });
    }
    return {
      version: PANEM_VERSION,
      pods: pods.sort((a, b) => a.block[0] - b.block[0]),
      unplaced: this.unplaced,
    };
  }

  async release(podId: string): Promise<boolean> {
    const had = this.o.alloc.release(podId);
    this.metaById.delete(podId);
    await this.o.alloc.save();
    this.syncListeners();
    return had;
  }

  stop() {
    for (const l of this.listeners.values()) l.stop(true);
    this.listeners.clear();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
