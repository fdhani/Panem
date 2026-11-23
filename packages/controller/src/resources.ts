/**
 * Machine and pod resource usage, collected on each machine through the machine shell (direct
 * for "local", SSH otherwise), on timers of its own so the main poll is never held up:
 *
 * - every 15 s: RAM (/proc/meminfo MemAvailable/MemTotal) and each pod container's RAM
 *   (docker stats --no-stream; nested Docker-in-Docker containers share its cgroup);
 * - every 60 s (5 min after a slow run): Docker's disk (df on DockerRootDir), each pod
 *   container's writable layer (docker ps -s), its volumes (docker inspect), and volume sizes
 *   (docker system df -v).
 *
 * Pods are matched to containers by the backend's uid (DevPod labels its containers
 * dev.containers.id=<workspace uid>). It also removes pods' Docker-in-Docker volumes, which
 * `devpod delete` leaves behind, and lists the ones nobody uses.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config, MachineResources, PodResources } from "@panem/core";
import { type MachineShell, shq } from "./shell";

export interface ResourceMachine {
  name: string;
  host: string;
  user?: string;
  status: string;
}

export interface ResourcePod {
  id: string;
  machine: string;
  /** The backend's id for its container (DevPod workspace uid). */
  uid?: string;
  /** Volumes recorded as the pod's own (PodMeta.volumes). */
  volumes?: string[];
}

export interface ResourceDeps {
  shell: MachineShell;
  machines(): ResourceMachine[];
  pods(): ResourcePod[];
  thresholds(): Config["resources"];
  /** Numbers changed: publish machines and pods. */
  onChange(): void;
  log(m: string): void;
  /** Where volumes still to remove are kept across restarts (pending-volumes.json). */
  dataDir?: string;
  now?: () => number;
}

export const FAST_MS = 15_000;
export const SLOW_MS = 60_000;
/** A storage run slower than this waits SLOW_BACKOFF_MS before the next. */
export const SLOW_RUN_LIMIT_MS = 10_000;
export const SLOW_BACKOFF_MS = 5 * 60_000;
/** The volume the docker-in-docker Feature mounts at /var/lib/docker: one per pod. */
export const DIND_PREFIX = "dind-var-lib-docker-";

// ---------- parsers (exported for tests) ----------

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

/**
 * A size as Docker prints it, in bytes: decimal units in `docker ps -s` and `system df`
 * ("1.15GB", "12.3kB", "0B"), binary ones in `docker stats` ("255.7MiB"). Undefined if unreadable.
 */
export function parseSize(s: string): number | undefined {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgGtTpP]?i?[bB])$/);
  if (!m) return undefined;
  const unit = UNITS[m[2]!.toLowerCase()];
  return unit === undefined ? undefined : Math.round(Number(m[1]) * unit);
}

/** /proc/meminfo: MemTotal and MemAvailable (kB there means KiB). */
export function parseMeminfo(s: string): { total: number; available: number } | undefined {
  const get = (k: string) => {
    const m = s.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const total = get("MemTotal");
  const available = get("MemAvailable");
  return total !== undefined && available !== undefined ? { total, available } : undefined;
}

/** `df -Pk <path>`: total and available on that filesystem, in bytes (1024-blocks). */
export function parseDf(s: string): { total: number; free: number } | undefined {
  const lines = s.trim().split("\n").filter(Boolean);
  const f = lines.at(-1)?.trim().split(/\s+/);
  if (!f || lines.length < 2 || f.length < 6) return undefined;
  const total = Number(f[1]);
  const free = Number(f[3]);
  return Number.isFinite(total) && Number.isFinite(free)
    ? { total: total * 1024, free: free * 1024 }
    : undefined;
}

/** `docker stats` MemUsage, "255.7MiB / 15.5GiB": the part in use. */
export function parseStatsMem(s: string): number | undefined {
  return parseSize(s.split("/")[0] ?? "");
}

/** `docker ps -s` Size, "1.15GB (virtual 3.13GB)": the writable layer and the whole. */
export function parsePsSize(s: string): { writable?: number; virtual?: number } {
  const m = s.match(/^\s*(\S+)(?:\s*\(virtual\s+(\S+)\))?/);
  return {
    writable: m ? parseSize(m[1]!) : undefined,
    virtual: m?.[2] ? parseSize(m[2]) : undefined,
  };
}

export interface VolumeUsage {
  name: string;
  size?: number;
  /** Containers using it (running or stopped). */
  links?: number;
}

/**
 * `docker system df -v --format '{{json .Volumes}}'`. Docker's CLI has printed both the API's
 * shape ({Name, UsageData: {Size, RefCount}}) and the table's ({Name, Size: "1.2GB",
 * Links: "1"}); both are read.
 */
export function parseVolumes(s: string): VolumeUsage[] {
  const raw = s.trim();
  if (!raw || raw === "null") return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    // One JSON object per line.
    arr = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  if (!Array.isArray(arr)) return [];
  const num = (v: unknown) =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
  return arr.flatMap((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    if (typeof o.Name !== "string") return [];
    const usage = (o.UsageData ?? {}) as Record<string, unknown>;
    const size =
      typeof usage.Size === "number" && usage.Size >= 0
        ? usage.Size
        : typeof o.Size === "string"
          ? parseSize(o.Size)
          : num(o.Size);
    const links = num(usage.RefCount) ?? num(o.Links);
    return [{ name: o.Name, size, links: links !== undefined && links >= 0 ? links : undefined }];
  });
}

export interface Mount {
  type: string;
  name: string;
  dest: string;
}

/** One `docker inspect` line: "<id>\t<type>|<name>|<destination>;..." */
export function parseMounts(line: string): { id: string; mounts: Mount[] } | undefined {
  const [id, rest = ""] = line.split("\t");
  if (!id?.trim()) return undefined;
  const mounts = rest
    .split(";")
    .filter(Boolean)
    .map((m) => {
      const [type = "", name = "", dest = ""] = m.split("|");
      return { type, name, dest };
    });
  return { id: id.trim(), mounts };
}

/** A pod's Docker-in-Docker volume(s): named volumes at /var/lib/docker with the Feature's prefix. */
export function dindVolumes(mounts: Mount[]): string[] {
  return mounts
    .filter(
      (m) => m.type === "volume" && m.dest === "/var/lib/docker" && m.name.startsWith(DIND_PREFIX),
    )
    .map((m) => m.name);
}

/** Split the scripts' output into sections ("@@panem:<name>" lines). */
export function sections(out: string): Map<string, string> {
  const m = new Map<string, string>();
  let cur = "";
  for (const line of out.split("\n")) {
    const h = line.match(/^@@panem:([a-z-]+)$/);
    if (h) {
      cur = h[1]!;
      m.set(cur, "");
    } else if (cur) {
      m.set(cur, `${m.get(cur)}${line}\n`);
    }
  }
  return m;
}

// ---------- the scripts run on machines ----------

const LABEL = "dev.containers.id";

export const FAST_SCRIPT = [
  "echo @@panem:os; uname -s",
  "echo @@panem:mem; cat /proc/meminfo 2>/dev/null",
  `echo @@panem:pods; docker ps --filter label=${LABEL} --format '{{.ID}}\t{{.Label "${LABEL}"}}'`,
  `ids=$(docker ps -q --filter label=${LABEL})`,
  `echo @@panem:stats; if [ -n "$ids" ]; then docker stats --no-stream --format '{{.ID}}\t{{.MemUsage}}' $ids; fi`,
  "true",
].join("\n");

export const SLOW_SCRIPT = [
  "root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)",
  'echo @@panem:root; echo "$root"',
  'echo @@panem:df; if [ -n "$root" ]; then df -Pk "$root"; fi',
  `echo @@panem:ps; docker ps -a -s --filter label=${LABEL} --format '{{.ID}}\t{{.Label "${LABEL}"}}\t{{.Image}}\t{{.Size}}'`,
  `ids=$(docker ps -aq --filter label=${LABEL})`,
  `echo @@panem:mounts; if [ -n "$ids" ]; then docker inspect --format '{{.Id}}\t{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' $ids; fi`,
  "echo @@panem:volumes; docker system df -v --format '{{json .Volumes}}'",
  "true",
].join("\n");

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Remove a volume only when no container (running or stopped) uses it. */
export function removeVolumeScript(name: string): string {
  const v = shq(name);
  return [
    `if [ -n "$(docker ps -aq --filter volume=${v})" ]; then echo in-use; exit 0; fi`,
    `out=$(docker volume rm ${v} 2>&1) && { echo removed; exit 0; }`,
    `case "$out" in *"no such volume"*|*"No such volume"*) echo removed; exit 0;; esac`,
    'echo "$out" >&2; exit 1',
  ].join("\n");
}

// ---------- the monitor ----------

interface FastData {
  at: string;
  os?: string;
  mem?: { total: number; available: number };
  /** uid -> RAM in use */
  podMem: Map<string, number>;
}

interface ContainerUsage {
  uid: string;
  image: string;
  writable?: number;
  imageSize?: number;
  dind: string[];
}

interface SlowData {
  at: string;
  disk?: { path: string; total: number; free: number };
  containers: ContainerUsage[];
  volumes: VolumeUsage[];
}

interface MachineState {
  fast?: FastData;
  slow?: SlowData;
  fastRunning?: boolean;
  slowRunning?: boolean;
  nextSlowAt?: number;
  fastStale?: boolean;
  slowStale?: boolean;
  error?: string;
}

export class ResourceMonitor {
  private state = new Map<string, MachineState>();
  /** machine name -> volumes to remove when it's next reachable */
  private pending = new Map<string, Set<string>>();
  private timers: Timer[] = [];
  private readonly now: () => number;

  constructor(private readonly d: ResourceDeps) {
    this.now = d.now ?? Date.now;
    this.loadPending();
  }

  start(): void {
    const fast = () => {
      for (const m of this.online()) void this.runFast(m);
    };
    const slow = () => {
      for (const m of this.online()) void this.runSlow(m);
    };
    this.timers.push(setTimeout(fast, 1000), setTimeout(slow, 2000));
    this.timers.push(setInterval(fast, FAST_MS), setInterval(slow, SLOW_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private online() {
    return this.d.machines().filter((m) => m.status !== "offline");
  }

  private st(name: string): MachineState {
    let s = this.state.get(name);
    if (!s) {
      s = {};
      this.state.set(name, s);
    }
    return s;
  }

  /** RAM: the machine's and each pod container's. Skipped while the last run is going. */
  async runFast(m: ResourceMachine): Promise<void> {
    const s = this.st(m.name);
    if (s.fastRunning) return;
    s.fastRunning = true;
    try {
      const r = await this.d.shell.run(m, ["sh", "-c", FAST_SCRIPT], { timeoutMs: 20_000 });
      const sec = sections(r.stdout);
      if (!sec.has("mem")) throw new Error(r.stderr.trim().split("\n").at(-1) || `exit ${r.code}`);
      const byShort = new Map<string, string>();
      for (const line of (sec.get("pods") ?? "").split("\n")) {
        const [id, uid] = line.split("\t");
        if (id && uid) byShort.set(id.trim(), uid.trim());
      }
      const podMem = new Map<string, number>();
      for (const line of (sec.get("stats") ?? "").split("\n")) {
        const [id, usage] = line.split("\t");
        const uid = id ? byShort.get(id.trim()) : undefined;
        const used = usage ? parseStatsMem(usage) : undefined;
        if (uid && used !== undefined) podMem.set(uid, used);
      }
      s.fast = {
        at: new Date(this.now()).toISOString(),
        os: sec.get("os")?.trim() || undefined,
        mem: parseMeminfo(sec.get("mem") ?? ""),
        podMem,
      };
      s.fastStale = false;
      this.clearError(m.name, s);
    } catch (e) {
      s.fastStale = !!s.fast;
      this.fail(m.name, s, e);
    } finally {
      s.fastRunning = false;
      this.d.onChange();
    }
  }

  /** Storage. Skipped while the last run is going, and for 5 minutes after a slow one. */
  async runSlow(m: ResourceMachine): Promise<void> {
    const s = this.st(m.name);
    if (s.slowRunning || (s.nextSlowAt && this.now() < s.nextSlowAt)) return;
    s.slowRunning = true;
    const t0 = this.now();
    try {
      const r = await this.d.shell.run(m, ["sh", "-c", SLOW_SCRIPT], { timeoutMs: 60_000 });
      const sec = sections(r.stdout);
      if (!sec.has("volumes")) {
        throw new Error(r.stderr.trim().split("\n").at(-1) || `exit ${r.code}`);
      }
      const root = sec.get("root")?.trim() ?? "";
      const df = parseDf(sec.get("df") ?? "");
      const mountsById = new Map<string, Mount[]>();
      for (const line of (sec.get("mounts") ?? "").split("\n")) {
        const p = parseMounts(line);
        if (p) mountsById.set(p.id, p.mounts);
      }
      const containers: ContainerUsage[] = [];
      for (const line of (sec.get("ps") ?? "").split("\n")) {
        const [id, uid, image, size] = line.split("\t");
        if (!id?.trim() || !uid?.trim()) continue;
        const { writable, virtual } = parsePsSize(size ?? "");
        const full = [...mountsById.keys()].find((k) => k.startsWith(id.trim()));
        containers.push({
          uid: uid.trim(),
          image: image?.trim() ?? "",
          writable,
          imageSize:
            virtual !== undefined && writable !== undefined ? virtual - writable : undefined,
          dind: full ? dindVolumes(mountsById.get(full)!) : [],
        });
      }
      s.slow = {
        at: new Date(this.now()).toISOString(),
        disk: root && df ? { path: root, ...df } : undefined,
        containers,
        volumes: parseVolumes(sec.get("volumes") ?? ""),
      };
      s.slowStale = false;
      this.clearError(m.name, s);
    } catch (e) {
      s.slowStale = !!s.slow;
      this.fail(m.name, s, e);
    } finally {
      s.slowRunning = false;
      if (this.now() - t0 > SLOW_RUN_LIMIT_MS) {
        s.nextSlowAt = this.now() + SLOW_BACKOFF_MS;
        this.d.log(
          `${m.name}: measuring storage took ${Math.round((this.now() - t0) / 1000)} s; next in 5 minutes`,
        );
      }
      this.d.onChange();
    }
    await this.removePending(m);
  }

  private fail(name: string, s: MachineState, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (s.error !== msg) this.d.log(`${name}: couldn't read resource usage: ${msg}`);
    s.error = msg;
  }

  private clearError(name: string, s: MachineState) {
    if (s.error && !s.fastStale && !s.slowStale) {
      this.d.log(`${name}: resource usage readable again`);
      s.error = undefined;
    }
  }

  /** A machine's resources as the UI shows them, or undefined before the first run. */
  machine(name: string): MachineResources | undefined {
    const s = this.state.get(name);
    if (!s || (!s.fast && !s.slow && !s.error)) return undefined;
    const pods = this.d.pods().filter((p) => p.machine === name && p.uid);
    const uids = new Set(pods.map((p) => p.uid!));
    const mine = (s.slow?.containers ?? []).filter((c) => uids.has(c.uid));
    const volSize = new Map((s.slow?.volumes ?? []).map((v) => [v.name, v]));
    let mem = 0;
    for (const [uid, used] of s.fast?.podMem ?? []) if (uids.has(uid)) mem += used;
    let storage = 0;
    for (const c of mine) {
      storage += c.writable ?? 0;
      for (const v of c.dind) storage += volSize.get(v)?.size ?? 0;
    }
    const images = new Map<string, number>();
    for (const c of mine) if (c.imageSize !== undefined) images.set(c.image, c.imageSize);
    const orphans = this.orphansOf(name);
    const t = this.d.thresholds();
    const memInfo = s.fast?.mem;
    const disk = s.slow?.disk;
    const low = (avail: number, total: number, pct: number, bytes: number) =>
      avail < bytes || (total > 0 && (avail / total) * 100 < pct);
    return {
      at: s.fast?.at ?? s.slow?.at ?? new Date(this.now()).toISOString(),
      ...(s.fast?.os ? { os: s.fast.os } : {}),
      ...(memInfo ? { mem: memInfo } : {}),
      ...(disk ? { disk } : {}),
      ...(s.fast || s.slow ? { pods: { mem, storage } } : {}),
      ...(s.slow ? { sharedImages: [...images.values()].reduce((a, b) => a + b, 0) } : {}),
      ...(s.slow
        ? {
            orphans: {
              count: orphans.length,
              bytes: orphans.reduce((a, o) => a + (o.size ?? 0), 0),
            },
          }
        : {}),
      low: {
        mem: !!memInfo && low(memInfo.available, memInfo.total, t.lowMemPercent, t.lowMemBytes),
        disk: !!disk && low(disk.free, disk.total, t.lowDiskPercent, t.lowDiskBytes),
      },
      ...(s.fastStale || s.slowStale ? { stale: true } : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  }

  /** A pod's resources, or undefined when not measured yet. */
  pod(p: ResourcePod): PodResources | undefined {
    if (!p.uid) return undefined;
    const s = this.state.get(p.machine);
    if (!s) return undefined;
    const mem = s.fast?.podMem.get(p.uid);
    const c = s.slow?.containers.find((x) => x.uid === p.uid);
    if (mem === undefined && !c) return undefined;
    const volSize = new Map((s.slow?.volumes ?? []).map((v) => [v.name, v.size]));
    const dindSizes = (c?.dind ?? []).map((v) => volSize.get(v));
    return {
      at: s.fast?.at ?? s.slow!.at,
      ...(mem !== undefined ? { mem } : {}),
      ...(c?.writable !== undefined ? { writable: c.writable } : {}),
      ...(c && dindSizes.length && dindSizes.every((x) => x !== undefined)
        ? { dind: dindSizes.reduce((a, b) => a! + b!, 0) }
        : {}),
      ...(s.fastStale || s.slowStale ? { stale: true } : {}),
    };
  }

  /** The DinD volumes the last storage run saw on a container (to record them with its pod). */
  dindOf(machine: string, uid: string): string[] | undefined {
    const c = this.state.get(machine)?.slow?.containers.find((x) => x.uid === uid);
    return c?.dind.length ? c.dind : undefined;
  }

  // ---------- volumes ----------

  /** DinD volumes nobody uses, that Panem didn't record and isn't already removing. */
  private orphansOf(machine: string): VolumeUsage[] {
    const s = this.state.get(machine);
    const known = new Set(this.d.pods().flatMap((p) => p.volumes ?? []));
    const pending = this.pending.get(machine) ?? new Set();
    return (s?.slow?.volumes ?? []).filter(
      (v) =>
        v.name.startsWith(DIND_PREFIX) &&
        v.links === 0 &&
        !known.has(v.name) &&
        !pending.has(v.name),
    );
  }

  /** A pod's DinD volumes, read from its container's mounts now. */
  async podVolumes(m: ResourceMachine, uid: string): Promise<string[]> {
    const r = await this.d.shell.run(
      m,
      [
        "sh",
        "-c",
        `ids=$(docker ps -aq --filter label=${LABEL}=${shq(uid)}); if [ -n "$ids" ]; then docker inspect --format '{{.Id}}\t{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' $ids; fi`,
      ],
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return r.stdout.split("\n").flatMap((l) => {
      const p = parseMounts(l);
      return p ? dindVolumes(p.mounts) : [];
    });
  }

  /**
   * Remove volumes (a deleted pod's), each only once no container uses it. What can't be
   * removed now (in use, machine unreachable, an error) is kept and retried on later runs.
   */
  async removeVolumes(
    m: ResourceMachine,
    names: string[],
  ): Promise<{ removed: string[]; kept: string[] }> {
    const removed: string[] = [];
    const kept: string[] = [];
    for (const name of names) {
      if (!VOLUME_NAME.test(name)) continue;
      try {
        const r = await this.d.shell.run(m, ["sh", "-c", removeVolumeScript(name)], {
          timeoutMs: 60_000,
        });
        if (r.code === 0 && r.stdout.trim() === "removed") removed.push(name);
        else {
          if (r.code !== 0)
            this.d.log(`${m.name}: couldn't remove volume ${name}: ${r.stderr.trim()}`);
          kept.push(name);
        }
      } catch (e) {
        this.d.log(`${m.name}: couldn't remove volume ${name}: ${(e as Error).message}`);
        kept.push(name);
      }
    }
    const p = this.pending.get(m.name) ?? new Set<string>();
    for (const n of removed) p.delete(n);
    for (const n of kept) p.add(n);
    this.pending.set(m.name, p);
    await this.savePending();
    if (removed.length) this.d.log(`${m.name}: removed volume(s) ${removed.join(", ")}`);
    return { removed, kept };
  }

  /** Remember volumes to remove when the machine is next reachable (e.g. after a force delete). */
  async queueRemoval(machine: string, names: string[]): Promise<void> {
    if (!names.length) return;
    const p = this.pending.get(machine) ?? new Set<string>();
    for (const n of names) if (VOLUME_NAME.test(n)) p.add(n);
    this.pending.set(machine, p);
    await this.savePending();
  }

  pendingFor(machine: string): string[] {
    return [...(this.pending.get(machine) ?? [])];
  }

  private async removePending(m: ResourceMachine) {
    const names = this.pendingFor(m.name);
    if (names.length) await this.removeVolumes(m, names);
  }

  /** Unused DinD volumes Panem didn't record, measured now (for the prune dialog and CLI). */
  async orphans(m: ResourceMachine): Promise<{ name: string; size?: number }[]> {
    this.st(m.name).nextSlowAt = undefined;
    await this.runSlow(m);
    return this.orphansOf(m.name).map((v) => ({ name: v.name, size: v.size }));
  }

  /** Remove the chosen unused DinD volumes; each is checked again right before removal. */
  async prune(
    m: ResourceMachine,
    names: string[],
  ): Promise<{
    removed: { name: string; size?: number }[];
    skipped: { name: string; reason: string }[];
  }> {
    const sizes = new Map(
      (this.state.get(m.name)?.slow?.volumes ?? []).map((v) => [v.name, v.size]),
    );
    const removed: { name: string; size?: number }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const known = new Set(this.d.pods().flatMap((p) => p.volumes ?? []));
    for (const name of names) {
      if (!name.startsWith(DIND_PREFIX) || !VOLUME_NAME.test(name)) {
        skipped.push({ name, reason: "not a Docker-in-Docker volume" });
        continue;
      }
      if (known.has(name)) {
        skipped.push({ name, reason: "belongs to a pod" });
        continue;
      }
      const r = await this.d.shell.run(m, ["sh", "-c", removeVolumeScript(name)], {
        timeoutMs: 60_000,
      });
      if (r.code === 0 && r.stdout.trim() === "removed")
        removed.push({ name, size: sizes.get(name) });
      else
        skipped.push({
          name,
          reason:
            r.stdout.trim() === "in-use" ? "in use by a container" : r.stderr.trim() || "failed",
        });
    }
    if (removed.length) {
      this.d.log(`${m.name}: pruned ${removed.length} unused volume(s)`);
      this.st(m.name).nextSlowAt = undefined;
      void this.runSlow(m);
    }
    return { removed, skipped };
  }

  private pendingFile() {
    return this.d.dataDir ? join(this.d.dataDir, "pending-volumes.json") : undefined;
  }

  private loadPending() {
    const f = this.pendingFile();
    if (!f || !existsSync(f)) return;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, string[]>;
      for (const [k, v] of Object.entries(j)) this.pending.set(k, new Set(v));
    } catch {
      // A broken file only means retries are forgotten.
    }
  }

  private async savePending() {
    const f = this.pendingFile();
    if (!f) return;
    const j = Object.fromEntries(
      [...this.pending].filter(([, v]) => v.size).map(([k, v]) => [k, [...v]]),
    );
    await mkdir(dirname(f), { recursive: true });
    await writeFile(`${f}.tmp`, `${JSON.stringify(j, null, 2)}\n`);
    await rename(`${f}.tmp`, f);
  }
}
