import type { MachineStatus } from "@panem/core";

/** Answers "is this machine reachable right now?" */
export interface HostProbe {
  status(hosts: { host: string; user?: string }[]): Promise<Map<string, MachineStatus>>;
}

async function cmd(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
}

/** Tailscale's peer list first; plain SSH reachability for hosts Tailscale doesn't know. */
export class TailscaleProbe implements HostProbe {
  async status(hosts: { host: string; user?: string }[]) {
    const result = new Map<string, MachineStatus>();
    const peers = await tailscalePeers();
    await Promise.all(
      hosts.map(async ({ host, user }) => {
        if (host === "local") return void result.set(host, "online");
        const key = host.toLowerCase().split(".")[0]!;
        const ts = peers?.get(key);
        if (ts !== undefined) return void result.set(host, ts ? "online" : "offline");
        const target = user ? `${user}@${host}` : host;
        const r = await cmd(
          ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "--", target, "true"],
          5000,
        );
        result.set(host, r.code === 0 ? "online" : r.code === 127 ? "unknown" : "offline");
      }),
    );
    return result;
  }
}

/** Map of lowercase short hostname -> online, or undefined when tailscale isn't available. */
export async function tailscalePeers(): Promise<Map<string, boolean> | undefined> {
  const r = await cmd(["tailscale", "status", "--json"], 5000);
  if (r.code !== 0) return undefined;
  try {
    return parseTailscaleStatus(r.out);
  } catch {
    return undefined;
  }
}

export function parseTailscaleStatus(raw: string): Map<string, boolean> {
  const j = JSON.parse(raw) as {
    Self?: { HostName?: string; DNSName?: string };
    Peer?: Record<string, { HostName?: string; DNSName?: string; Online?: boolean }>;
  };
  const m = new Map<string, boolean>();
  const add = (p: { HostName?: string; DNSName?: string }, online: boolean) => {
    for (const n of [p.HostName, p.DNSName?.split(".")[0]]) {
      if (n) m.set(n.toLowerCase(), online);
    }
  };
  if (j.Self) add(j.Self, true);
  for (const p of Object.values(j.Peer ?? {})) add(p, p.Online === true);
  return m;
}

export async function tailscaleIPv4(): Promise<string | undefined> {
  const r = await cmd(["tailscale", "ip", "-4"], 3000);
  return r.code === 0 ? r.out.trim().split("\n")[0] || undefined : undefined;
}

export class StaticProbe implements HostProbe {
  constructor(public statuses: Record<string, MachineStatus> = {}) {}
  async status(hosts: { host: string }[]) {
    return new Map(hosts.map((h) => [h.host, this.statuses[h.host] ?? "online"] as const));
  }
}

/** Map of lowercase short hostname -> Tailscale IPv4, from `tailscale status --json`. */
export async function tailscalePeerIPs(): Promise<Map<string, string> | undefined> {
  const r = await cmd(["tailscale", "status", "--json"], 5000);
  if (r.code !== 0) return undefined;
  try {
    return parseTailscaleIPs(r.out);
  } catch {
    return undefined;
  }
}

export function parseTailscaleIPs(raw: string): Map<string, string> {
  type Node = { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
  const j = JSON.parse(raw) as { Self?: Node; Peer?: Record<string, Node> };
  const m = new Map<string, string>();
  for (const n of [j.Self, ...Object.values(j.Peer ?? {})]) {
    const ip = n?.TailscaleIPs?.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
    if (!n || !ip) continue;
    for (const name of [n.HostName, n.DNSName?.split(".")[0]]) {
      if (name) m.set(name.toLowerCase(), ip);
    }
  }
  return m;
}
