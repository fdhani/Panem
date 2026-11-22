import {
  type Config,
  FORWARDER_CONTAINER,
  FORWARDER_IMAGE,
  type ForwarderState as FState,
  ForwarderState,
  type ForwarderStatus,
  PANEM_VERSION,
} from "@panem/core";
import { tailscaleIPv4, tailscalePeerIPs } from "./probe";
import type { MachineShell } from "./shell";

export interface MachineRef {
  name: string;
  host: string;
  user?: string;
}

/** What the pod service needs from forwarders; MockForwarders implements it for UI work. */
export interface Forwarders {
  readonly enabled: boolean;
  /** Host to put in links for this machine (its Tailscale name, or IP for "local"). */
  linkHost(m: MachineRef): Promise<string>;
  state(m: MachineRef): Promise<FState>;
  ensure(m: MachineRef): Promise<ForwarderStatus>;
  release(m: MachineRef, podId: string): Promise<void>;
  /** Set which pod ports are switched on (published on the machine). */
  setExposed(m: MachineRef, podId: string, ports: number[]): Promise<void>;
  remove(m: MachineRef): Promise<void>;
}

const VERSION_LABEL = "dev.panem.version";

/**
 * Deploys and talks to the panem-forwarder container on each machine.
 * Deploy goes over SSH (docker CLI); state is read over HTTP on the machine's Tailscale IP.
 */
export class ForwarderManager implements Forwarders {
  readonly enabled: boolean;
  private readonly image: string;
  private readonly addrCache = new Map<string, string>();

  constructor(
    private readonly cfg: Config,
    private readonly shell: MachineShell,
    private readonly deps: {
      fetch?: typeof fetch;
      localAddress?: () => Promise<string | undefined>;
      peerIPs?: () => Promise<Map<string, string> | undefined>;
    } = {},
  ) {
    this.enabled = Boolean(cfg.relaySecret && cfg.forwarderToken);
    this.image = cfg.forwarder.image ?? `${FORWARDER_IMAGE}:${PANEM_VERSION}`;
  }

  /** The machine's Tailscale IPv4: published ports bind to it, and state is fetched from it. */
  async address(m: MachineRef): Promise<string> {
    const cached = this.addrCache.get(m.name);
    if (cached) return cached;
    let ip: string | undefined;
    if (m.host === "local") {
      ip = (await (this.deps.localAddress ?? tailscaleIPv4)()) ?? "127.0.0.1";
    } else {
      ip = (await (this.deps.peerIPs ?? tailscalePeerIPs)())?.get(
        m.host.toLowerCase().split(".")[0]!,
      );
      if (!ip) {
        const r = await this.shell.run(m, ["tailscale", "ip", "-4"], { timeoutMs: 15_000 });
        ip = r.code === 0 ? r.stdout.trim().split("\n")[0] : undefined;
      }
    }
    if (!ip || !/^[0-9.]+$/.test(ip)) throw new Error(`no Tailscale IPv4 for ${m.host}`);
    this.addrCache.set(m.name, ip);
    return ip;
  }

  async linkHost(m: MachineRef): Promise<string> {
    return m.host === "local" ? this.address(m) : m.host;
  }

  private async control(
    m: MachineRef,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const ip = await this.address(m);
    return (this.deps.fetch ?? fetch)(`http://${ip}:${this.cfg.forwarder.controlPort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.forwarderToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  }

  async setExposed(m: MachineRef, podId: string, ports: number[]): Promise<void> {
    if (!this.enabled) throw new Error("port forwarding is not configured");
    const res = await this.control(m, "PUT", `/pods/${encodeURIComponent(podId)}/exposed`, {
      ports,
    });
    if (!res.ok) {
      const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(`forwarder: ${err ?? res.status}`);
    }
  }

  async state(m: MachineRef): Promise<FState> {
    const res = await this.control(m, "GET", "/state");
    if (!res.ok) throw new Error(`forwarder /state: ${res.status}`);
    return ForwarderState.parse(await res.json());
  }

  async release(m: MachineRef, podId: string): Promise<void> {
    if (!this.enabled) return;
    const res = await this.control(m, "DELETE", `/pods/${encodeURIComponent(podId)}`);
    if (!res.ok) throw new Error(`forwarder release: ${res.status}`);
  }

  /** docker run arguments; secrets go through --env-file on stdin, never argv. */
  runArgs(address: string): { argv: string[]; env: string } {
    const { portRange, controlPort, blockSize } = this.cfg.forwarder;
    const range = `${portRange[0]}-${portRange[1]}`;
    return {
      argv: [
        "docker",
        "run",
        "-d",
        "--name",
        FORWARDER_CONTAINER,
        "--restart",
        "unless-stopped",
        "--label",
        `${VERSION_LABEL}=${PANEM_VERSION}`,
        "-p",
        `${address}:${controlPort}:${controlPort}`,
        "-p",
        `${address}:${range}:${range}`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        "panem-forwarder:/data",
        "--env-file",
        "/dev/stdin",
        this.image,
      ],
      env: [
        `PANEM_FORWARDER_TOKEN=${this.cfg.forwarderToken}`,
        `PANEM_RELAY_SECRET=${this.cfg.relaySecret}`,
        `PANEM_PORT_RANGE=${range}`,
        `PANEM_BLOCK_SIZE=${blockSize}`,
        `PANEM_CONTROL_PORT=${controlPort}`,
        "",
      ].join("\n"),
    };
  }

  /** Make sure the right forwarder version runs on the machine. Idempotent. */
  async ensure(m: MachineRef): Promise<ForwarderStatus> {
    if (!this.enabled) return { status: "disabled" };
    const address = await this.address(m);
    const inspect = await this.shell.run(m, [
      "docker",
      "inspect",
      "--format",
      `{{.Config.Image}}|{{.State.Running}}|{{index .Config.Labels "${VERSION_LABEL}"}}`,
      FORWARDER_CONTAINER,
    ]);
    const [image, running, version] = inspect.stdout.trim().split("|");
    if (
      inspect.code === 0 &&
      image === this.image &&
      running === "true" &&
      version === PANEM_VERSION
    ) {
      return { status: "running", version, address };
    }
    await this.shell.run(m, ["docker", "rm", "-f", FORWARDER_CONTAINER]);
    const pull = await this.shell.run(m, ["docker", "pull", this.image], { timeoutMs: 600_000 });
    if (pull.code !== 0) {
      // A locally built image is fine (dev, CI); otherwise surface the pull error.
      const local = await this.shell.run(m, ["docker", "image", "inspect", this.image]);
      if (local.code !== 0) throw new Error(`docker pull ${this.image}: ${lastLine(pull.stderr)}`);
    }
    const { argv, env } = this.runArgs(address);
    const run = await this.shell.run(m, argv, { stdin: env });
    if (run.code !== 0) throw new Error(`docker run: ${lastLine(run.stderr)}`);
    return { status: "running", version: PANEM_VERSION, address };
  }

  async remove(m: MachineRef): Promise<void> {
    await this.shell.run(m, ["docker", "rm", "-f", FORWARDER_CONTAINER]);
    this.addrCache.delete(m.name);
  }
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter(Boolean).at(-1) ?? "failed";
}
