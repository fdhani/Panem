import {
  type Config,
  FORWARDER_CONTAINER,
  type ForwarderState as FState,
  ForwarderState,
  type ForwarderStatus,
  PANEM_VERSION,
} from "@panem/core";
import { forwarderBundle, shortHash } from "./machine-assets";
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
const BUNDLE_LABEL = "dev.panem.bundle";

/**
 * The public image the forwarder runs in (Docker Hub, Intel and ARM): Bun, the same version
 * Panem is built with. Panem copies the forwarder's code next to it; nothing is published.
 */
export const BUN_IMAGE = `oven/bun:${Bun.version}-alpine`;

/** Where the forwarder's code lives on each machine (mounted read-only into the container). */
const BUNDLE_DIR = "$HOME/.panem-forwarder";

/**
 * Deploys and talks to the panem-forwarder container on each machine.
 * Deploy goes over SSH (docker CLI); state is read over HTTP on the machine's Tailscale IP.
 */
export class ForwarderManager implements Forwarders {
  readonly enabled: boolean;
  /** A prebuilt forwarder image (config.forwarder.image), or undefined to run the bundle. */
  private readonly customImage?: string;
  private readonly addrCache = new Map<string, string>();
  /** Deploys in progress, per machine: a second request joins the first. */
  private readonly deploying = new Map<string, Promise<ForwarderStatus>>();

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
    this.customImage = cfg.forwarder.image;
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

  /**
   * docker run arguments; secrets go through --env-file on stdin, never argv. With `bundle`,
   * the public Bun image runs the forwarder code from the machine's bundle folder.
   */
  runArgs(
    address: string,
    bundle?: { dir: string; file: string; hash: string },
  ): { argv: string[]; env: string } {
    const { portRange, controlPort, blockSize } = this.cfg.forwarder;
    const range = `${portRange[0]}-${portRange[1]}`;
    const image = bundle ? BUN_IMAGE : (this.customImage ?? "");
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
        ...(bundle ? ["--label", `${BUNDLE_LABEL}=${bundle.hash}`] : []),
        "-p",
        `${address}:${controlPort}:${controlPort}`,
        "-p",
        `${address}:${range}:${range}`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        "panem-forwarder:/data",
        ...(bundle ? ["-v", `${bundle.dir}:/app:ro`] : []),
        "--env-file",
        "/dev/stdin",
        image,
        ...(bundle ? ["bun", `/app/${bundle.file}`] : []),
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

  /**
   * Make sure the right forwarder runs on the machine. Idempotent. By default the controller
   * copies the forwarder's code (one JS file) to the machine and runs it with the public Bun
   * image, so nothing has to be published; `config.forwarder.image` runs a prebuilt image.
   */
  async ensure(m: MachineRef): Promise<ForwarderStatus> {
    if (!this.enabled) return { status: "disabled" };
    // One deploy per machine at a time: two at once would remove each other's container (a
    // restart's automatic redeploy and a manual repair, say).
    const running = this.deploying.get(m.name);
    if (running) return running;
    const p = this.deploy(m).finally(() => this.deploying.delete(m.name));
    this.deploying.set(m.name, p);
    return p;
  }

  private async deploy(m: MachineRef): Promise<ForwarderStatus> {
    const address = await this.address(m);
    const code = this.customImage ? undefined : await forwarderBundle();
    const hash = code === undefined ? "" : shortHash(code);
    const image = this.customImage ?? BUN_IMAGE;
    const inspect = await this.shell.run(m, [
      "docker",
      "inspect",
      "--format",
      `{{.Config.Image}}|{{.State.Running}}|{{index .Config.Labels "${VERSION_LABEL}"}}|{{index .Config.Labels "${BUNDLE_LABEL}"}}`,
      FORWARDER_CONTAINER,
    ]);
    const [cur, running, version, curHash = ""] = inspect.stdout.trim().split("|");
    if (
      inspect.code === 0 &&
      cur === image &&
      running === "true" &&
      version === PANEM_VERSION &&
      curHash.replace("<no value>", "") === hash
    ) {
      return { status: "running", version, address };
    }
    await this.shell.run(m, ["docker", "rm", "-f", FORWARDER_CONTAINER]);
    const pull = await this.shell.run(m, ["docker", "pull", image], { timeoutMs: 600_000 });
    if (pull.code !== 0) {
      // A local image is fine (dev, CI, offline machines); otherwise surface the pull error.
      const local = await this.shell.run(m, ["docker", "image", "inspect", image]);
      if (local.code !== 0) throw new Error(`docker pull ${image}: ${dockerError(pull.stderr)}`);
    }
    let bundle: { dir: string; file: string; hash: string } | undefined;
    if (code !== undefined) {
      const file = `forwarder-${hash}.js`;
      // Replace older bundles, write the new one, and print the folder's absolute path.
      const put = await this.shell.run(
        m,
        [
          "sh",
          "-c",
          `d="${BUNDLE_DIR}" && mkdir -p "$d" && rm -f "$d"/forwarder-*.js && cat > "$d/.${file}.tmp" && mv "$d/.${file}.tmp" "$d/${file}" && echo "$d"`,
        ],
        { stdin: code },
      );
      const dir = put.stdout.trim().split("\n").at(-1) ?? "";
      if (put.code !== 0 || !dir.startsWith("/")) {
        throw new Error(`copying the forwarder to ${m.host}: ${dockerError(put.stderr)}`);
      }
      bundle = { dir, file, hash };
    }
    const { argv, env } = this.runArgs(address, bundle);
    const run = await this.shell.run(m, argv, { stdin: env });
    if (run.code !== 0) throw new Error(`docker run: ${dockerError(run.stderr)}`);
    return { status: "running", version: PANEM_VERSION, address };
  }

  async remove(m: MachineRef): Promise<void> {
    await this.shell.run(m, ["docker", "rm", "-f", FORWARDER_CONTAINER]);
    this.addrCache.delete(m.name);
  }
}

/**
 * The line of a docker command's stderr that says what went wrong: the first that mentions an
 * error, else the first that isn't the usage footer ("See 'docker run --help'.").
 */
export function dockerError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const footer = /^(See '.*--help'\.?|Run '.*--help' for more information\.?)$/;
  const useful = lines.filter((l) => !footer.test(l));
  return useful.find((l) => /error/i.test(l)) ?? useful[0] ?? lines.at(-1) ?? "failed";
}
