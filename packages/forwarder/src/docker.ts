/** Minimal Docker Engine API client over the unix socket. */

export interface ContainerInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
  /** network id -> IPv4 address on that network */
  networks: Map<string, string>;
}

export interface DockerApi {
  running(): Promise<ContainerInfo[]>;
  connectNetwork(networkId: string, containerId: string): Promise<void>;
}

interface RawContainer {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string; IPAddress?: string }> };
}

export class DockerClient implements DockerApi {
  constructor(private readonly socket = "/var/run/docker.sock") {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`http://docker${path}`, {
      method,
      unix: this.socket,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    } as RequestInit & { unix: string });
    if (!res.ok) throw new Error(`docker ${method} ${path}: ${res.status} ${await res.text()}`);
    return res;
  }

  async running(): Promise<ContainerInfo[]> {
    const raw = (await (await this.call("GET", "/containers/json")).json()) as RawContainer[];
    return raw.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? "").replace(/^\//, ""),
      labels: c.Labels ?? {},
      networks: new Map(
        Object.values(c.NetworkSettings?.Networks ?? {})
          .filter((n) => n.NetworkID && n.IPAddress)
          .map((n) => [n.NetworkID!, n.IPAddress!]),
      ),
    }));
  }

  async connectNetwork(networkId: string, containerId: string): Promise<void> {
    await this.call("POST", `/networks/${networkId}/connect`, { Container: containerId });
  }
}
