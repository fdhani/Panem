import { describe, expect, test } from "bun:test";
import {
  type Config,
  Config as ConfigSchema,
  type ForwarderState,
  PANEM_VERSION,
} from "@panem/core";
import { BUN_IMAGE, ForwarderManager, type Forwarders, dockerError } from "../src/forwarders";
import { forwarderBundle, shortHash } from "../src/machine-assets";
import { parseTailscaleIPs } from "../src/probe";
import type { MachineShell, ShellResult } from "../src/shell";
import { shq } from "../src/shell";
import { makeController, makeWorkspace, until } from "./helpers";

const cfg: Config = ConfigSchema.parse({
  workspaceDir: "/tmp/ws",
  apiToken: "api-token-0123456789",
  relaySecret: "relay-secret-0123456789",
  forwarderToken: "fwd-token-0123456789",
});

class FakeShell implements MachineShell {
  calls: { host: string; argv: string[]; stdin?: string }[] = [];
  replies: [RegExp, Partial<ShellResult>][] = [];
  async run(m: { host: string }, argv: string[], opts: { stdin?: string } = {}) {
    this.calls.push({ host: m.host, argv, stdin: opts.stdin });
    const line = argv.join(" ");
    const r = this.replies.find(([re]) => re.test(line))?.[1] ?? {};
    return { code: 0, stdout: "", stderr: "", ...r };
  }
  cmds() {
    return this.calls.map((c) => c.argv.slice(0, 2).join(" "));
  }
}

const vps = { name: "m-vps", host: "vps", user: "dev" };
const mgr = (shell: FakeShell, peers = new Map([["vps", "100.64.0.5"]])) =>
  new ForwarderManager(cfg, shell, {
    peerIPs: async () => peers,
    localAddress: async () => undefined,
  });

describe("ForwarderManager", () => {
  test("deploys the forwarder's code to the machine and runs it with the public Bun image", async () => {
    const shell = new FakeShell();
    shell.replies.push(
      [/docker inspect/, { code: 1, stderr: "No such object" }],
      [/^sh -c/, { stdout: "/home/dev/.panem-forwarder\n" }],
    );
    const st = await mgr(shell).ensure(vps);
    expect(st).toEqual({ status: "running", version: PANEM_VERSION, address: "100.64.0.5" });
    expect(shell.cmds()).toEqual([
      "docker inspect",
      "docker rm",
      "docker pull",
      "sh -c",
      "docker run",
    ]);
    expect(shell.calls[2]!.argv).toEqual(["docker", "pull", BUN_IMAGE]);
    expect(BUN_IMAGE).toBe(`oven/bun:${Bun.version}-alpine`);

    // The bundle goes over stdin, under a name carrying its content hash.
    const bundle = await forwarderBundle();
    const hash = shortHash(bundle);
    const put = shell.calls[3]!;
    expect(put.stdin).toBe(bundle);
    expect(put.argv[2]).toContain(`forwarder-${hash}.js`);
    expect(put.argv[2]).toContain('rm -f "$d"/forwarder-*.js');

    const run = shell.calls.at(-1)!;
    const line = run.argv.join(" ");
    expect(line).toContain("-p 100.64.0.5:7599:7599");
    expect(line).toContain("-p 100.64.0.5:7600-7699:7600-7699");
    expect(line).toContain("--restart unless-stopped");
    expect(line).toContain(`--label dev.panem.bundle=${hash}`);
    expect(line).toContain("-v /home/dev/.panem-forwarder:/app:ro");
    expect(run.argv.slice(-3)).toEqual([BUN_IMAGE, "bun", `/app/forwarder-${hash}.js`]);
    expect(line).not.toContain("0.0.0.0");
    expect(line).not.toContain("ghcr.io");
    expect(line).not.toContain("relay-secret");
    expect(line).not.toContain("fwd-token");
    expect(run.stdin).toContain("PANEM_RELAY_SECRET=relay-secret-0123456789");
    expect(run.stdin).toContain("PANEM_FORWARDER_TOKEN=fwd-token-0123456789");
  });

  test("leaves a matching forwarder alone; recreates an old version or changed code", async () => {
    const hash = shortHash(await forwarderBundle());
    const ok = new FakeShell();
    ok.replies.push([/docker inspect/, { stdout: `${BUN_IMAGE}|true|${PANEM_VERSION}|${hash}\n` }]);
    await mgr(ok).ensure(vps);
    expect(ok.cmds()).toEqual(["docker inspect"]);

    for (const stdout of [
      `ghcr.io/fdhani/panem/forwarder:${PANEM_VERSION}|true|${PANEM_VERSION}|<no value>`,
      `${BUN_IMAGE}|true|0.1.0|${hash}`,
      `${BUN_IMAGE}|true|${PANEM_VERSION}|0123456789ab`,
      `${BUN_IMAGE}|false|${PANEM_VERSION}|${hash}`,
    ]) {
      const old = new FakeShell();
      old.replies.push(
        [/docker inspect/, { stdout }],
        [/^sh -c/, { stdout: "/root/.panem-forwarder\n" }],
      );
      await mgr(old).ensure(vps);
      expect(old.cmds()).toContain("docker run");
    }
  });

  test("an image that can't be pulled is fine if the machine has it, fatal without", async () => {
    const local = new FakeShell();
    local.replies.push(
      [/docker inspect/, { code: 1 }],
      [/docker pull/, { code: 1, stderr: "no internet" }],
      [/^sh -c/, { stdout: "/root/.panem-forwarder\n" }],
    );
    await mgr(local).ensure(vps);
    expect(local.cmds()).toContain("docker run");

    const none = new FakeShell();
    none.replies.push(
      [/docker inspect/, { code: 1 }],
      [
        /docker pull/,
        {
          code: 1,
          stderr: "Using default tag: latest\nError response from daemon: manifest unknown",
        },
      ],
      [/docker image inspect/, { code: 1 }],
    );
    await expect(mgr(none).ensure(vps)).rejects.toThrow("manifest unknown");
  });

  test("two deploys of one machine at once: the second joins the first", async () => {
    const shell = new FakeShell();
    shell.replies.push(
      [/docker inspect/, { code: 1, stderr: "No such object" }],
      [/^sh -c/, { stdout: "/home/dev/.panem-forwarder\n" }],
    );
    const m = mgr(shell);
    const [a, b] = await Promise.all([m.ensure(vps), m.ensure(vps)]);
    expect(a).toEqual(b);
    expect(shell.cmds().filter((c) => c === "docker run")).toHaveLength(1);
    expect(shell.cmds().filter((c) => c === "docker rm")).toHaveLength(1);
    // Once it's done, a later repair checks again.
    await m.ensure(vps);
    expect(shell.cmds().filter((c) => c === "docker inspect")).toHaveLength(2);
  });

  test("a failed docker run reports Docker's error, not its usage footer", async () => {
    const shell = new FakeShell();
    shell.replies.push(
      [/docker inspect/, { code: 1, stderr: "No such object" }],
      [/^sh -c/, { stdout: "/home/dev/.panem-forwarder\n" }],
      [
        /docker run/,
        {
          code: 125,
          stderr:
            'docker: Error response from daemon: Conflict. The container name "/panem-forwarder" is already in use by container "4f1c".\nSee \'docker run --help\'.\n',
        },
      ],
    );
    await expect(mgr(shell).ensure(vps)).rejects.toThrow(
      'docker run: docker: Error response from daemon: Conflict. The container name "/panem-forwarder" is already in use',
    );
    expect(dockerError("Run 'docker run --help' for more information\n")).toBe(
      "Run 'docker run --help' for more information",
    );
    expect(dockerError("")).toBe("failed");
  });

  test("a failed copy of the forwarder's code is reported", async () => {
    const shell = new FakeShell();
    shell.replies.push(
      [/docker inspect/, { code: 1 }],
      [/^sh -c/, { code: 1, stderr: "No space left on device" }],
    );
    await expect(mgr(shell).ensure(vps)).rejects.toThrow("No space left on device");
    expect(shell.cmds()).not.toContain("docker run");
  });

  test("config.forwarder.image still runs a prebuilt image, with no code copied", async () => {
    const custom = new ForwarderManager(
      ConfigSchema.parse({ ...cfg, forwarder: { image: "registry.local/forwarder:dev" } }),
      Object.assign(new FakeShell(), {}),
      { peerIPs: async () => new Map([["vps", "100.64.0.5"]]) },
    );
    const shell = (custom as unknown as { shell: FakeShell }).shell;
    shell.replies.push([/docker inspect/, { code: 1 }]);
    await custom.ensure(vps);
    expect(shell.cmds()).toEqual(["docker inspect", "docker rm", "docker pull", "docker run"]);
    expect(shell.calls.at(-1)!.argv.at(-1)).toBe("registry.local/forwarder:dev");
    expect(shell.calls.at(-1)!.argv.join(" ")).not.toContain("/app");
  });

  test("Tailscale IP: peer list first, then `tailscale ip -4` on the machine", async () => {
    const shell = new FakeShell();
    shell.replies.push([/tailscale ip -4/, { stdout: "100.64.0.9\n" }]);
    expect(await mgr(shell, new Map()).address(vps)).toBe("100.64.0.9");
    expect(await mgr(new FakeShell()).address({ name: "m-local", host: "local" })).toBe(
      "127.0.0.1",
    );
    const bad = new FakeShell();
    bad.replies.push([/tailscale ip -4/, { code: 1 }]);
    await expect(mgr(bad, new Map()).address(vps)).rejects.toThrow("no Tailscale IPv4");
  });

  test("state is fetched with the token and validated", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const m = new ForwarderManager(cfg, new FakeShell(), {
      peerIPs: async () => new Map([["vps", "100.64.0.5"]]),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, auth: new Headers(init.headers).get("authorization") });
        return Response.json({ version: PANEM_VERSION, pods: [] });
      }) as unknown as typeof fetch,
    });
    expect((await m.state(vps)).pods).toEqual([]);
    expect(seen[0]).toEqual({
      url: "http://100.64.0.5:7599/state",
      auth: "Bearer fwd-token-0123456789",
    });
  });

  test("disabled without secrets", async () => {
    const m = new ForwarderManager(
      ConfigSchema.parse({ workspaceDir: "/tmp/ws", apiToken: "a".repeat(16) }),
      new FakeShell(),
    );
    expect(m.enabled).toBe(false);
    expect(await m.ensure(vps)).toEqual({ status: "disabled" });
  });

  test("helpers", () => {
    expect(shq("a b'c")).toBe(`'a b'\\''c'`);
    expect(shq("PANEM_X=1")).toBe("PANEM_X=1");
    const ips = parseTailscaleIPs(
      JSON.stringify({
        Self: { HostName: "home", TailscaleIPs: ["100.64.0.1", "fd7a::1"] },
        Peer: {
          a: {
            HostName: "VPS",
            DNSName: "vps.tail.ts.net.",
            TailscaleIPs: ["fd7a::2", "100.64.0.5"],
          },
        },
      }),
    );
    expect(ips.get("home")).toBe("100.64.0.1");
    expect(ips.get("vps")).toBe("100.64.0.5");
  });
});

/** In-memory forwarder per machine, driven by tests. */
class FakeForwarders implements Forwarders {
  enabled = true;
  states = new Map<string, ForwarderState>();
  down = new Set<string>();
  ensured: string[] = [];
  released: [string, string][] = [];
  async linkHost(m: { host: string }) {
    return m.host;
  }
  async state(m: { name: string }) {
    if (this.down.has(m.name)) throw new Error("connection refused");
    return this.states.get(m.name) ?? { version: PANEM_VERSION, pods: [], unplaced: [] };
  }
  async ensure(m: { name: string }) {
    this.ensured.push(m.name);
    this.down.delete(m.name);
    return { status: "running" as const, version: PANEM_VERSION };
  }
  async release(m: { name: string }, id: string) {
    this.released.push([m.name, id]);
    const st = this.states.get(m.name);
    if (st) st.pods = st.pods.filter((p) => p.id !== id);
  }
  async remove() {}
  pushed: [string, string, number[]][] = [];
  async setExposed(m: { name: string }, id: string, ports: number[]) {
    this.pushed.push([m.name, id, ports]);
    const pod = this.states.get(m.name)?.pods.find((p) => p.id === id);
    if (!pod) return;
    let slot = 0;
    const all = new Set([...pod.ports.map((p) => p.podPort), ...ports]);
    pod.ports = [...all]
      .sort((a, b) => a - b)
      .map((podPort) => {
        const prev = pod.ports.find((p) => p.podPort === podPort);
        const on = ports.includes(podPort);
        if (on) slot++;
        return {
          podPort,
          name: prev?.name,
          live: prev?.live ?? false,
          exposed: on,
          slot: on ? slot : undefined,
          hostPort: on ? 7600 + slot : undefined,
        };
      });
  }
  /** Forwarder report for a pod: [podPort, hostPort | undefined (closed), name?]. */
  podState(machine: string, id: string, ports: [number, number | undefined, string?][]) {
    const st = this.states.get(machine) ?? { version: PANEM_VERSION, pods: [], unplaced: [] };
    st.pods.push({
      id,
      block: [7600, 7609],
      reachable: true,
      unmapped: [],
      ports: ports.map(([podPort, hostPort, name], i) => ({
        podPort,
        name,
        live: true,
        exposed: hostPort !== undefined,
        slot: hostPort === undefined ? undefined : i + 1,
        hostPort,
      })),
    });
    this.states.set(machine, st);
  }
}

async function setup() {
  const ws = makeWorkspace();
  const fwd = new FakeForwarders();
  const ctl = await makeController({
    ...ws,
    forwarders: fwd,
    relaySecret: "relay-secret-0123456789",
  });
  return { ws, fwd, ctl };
}

describe("pod service with forwarders", () => {
  test("pods carry their exposed ports and machines their forwarder status", async () => {
    const { fwd, ctl } = await setup();
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    const pod = (await res.json()) as { id: string };
    await until(() => ctl.service.get(pod.id).state === "running");
    expect(JSON.parse(ctl.backend.pods.get(pod.id)!.env.PANEM_POD!).id).toBe(pod.id);
    expect(ctl.backend.pods.get(pod.id)!.env.PANEM_RELAY_SECRET).toBe("relay-secret-0123456789");

    // The forwarder found two ports; nothing is switched on yet (template names none).
    fwd.podState("m-vps", pod.id, [
      [5173, undefined],
      [8000, undefined],
    ]);
    await ctl.service.refresh();
    expect(
      ctl.service.get(pod.id).services.map((x) => [x.podPort, x.live, x.exposed, x.url]),
    ).toEqual([
      [5173, true, false, undefined],
      [8000, true, false, undefined],
    ]);
    expect(ctl.service.get(pod.id).indexUrl).toBeUndefined();

    // Switch 5173 on: stored with the pod, pushed to the forwarder, link appears.
    const on = await ctl.req("PUT", `/api/pods/${pod.id}/ports/5173`, { exposed: true });
    expect(on.status).toBe(200);
    expect(fwd.pushed.at(-1)).toEqual(["m-vps", pod.id, [5173]]);
    const p = ctl.service.get(pod.id);
    expect(p.exposePorts).toEqual([5173]);
    expect(p.indexUrl).toBe("http://vps:7600");
    expect(p.services[0]).toMatchObject({
      podPort: 5173,
      live: true,
      exposed: true,
      hostPort: 7601,
      url: "http://vps:7601",
    });
    expect(p.services[1]!.exposed).toBe(false);

    // And off again.
    await ctl.req("PUT", `/api/pods/${pod.id}/ports/5173`, { exposed: false });
    expect(fwd.pushed.at(-1)).toEqual(["m-vps", pod.id, []]);
    expect(ctl.service.get(pod.id).services[0]!.url).toBeUndefined();
    expect((await ctl.req("PUT", `/api/pods/${pod.id}/ports/0`, { exposed: true })).status).toBe(
      400,
    );
    expect((await ctl.req("PUT", "/api/pods/nope/ports/80", { exposed: true })).status).toBe(404);
    expect(ctl.service.machines().find((m) => m.name === "m-vps")?.forwarder).toEqual({
      status: "running",
      version: PANEM_VERSION,
    });
  });

  test("the forwarder is brought back in line with stored switches on each poll", async () => {
    const { fwd, ctl } = await setup();
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    const pod = (await res.json()) as { id: string };
    await until(() => ctl.service.get(pod.id).state === "running");
    fwd.podState("m-vps", pod.id, [[3000, undefined]]);
    await ctl.service.refresh();
    await ctl.req("PUT", `/api/pods/${pod.id}/ports/3000`, { exposed: true });
    // e.g. the forwarder was redeployed and lost its state
    fwd.states.get("m-vps")!.pods[0]!.ports = [{ podPort: 3000, live: true, exposed: false }];
    fwd.pushed = [];
    await ctl.service.refresh();
    expect(fwd.pushed).toEqual([["m-vps", pod.id, [3000]]]);
  });

  test("a silent forwarder is marked missing and redeployed", async () => {
    const { fwd, ctl } = await setup();
    fwd.down.add("m-mac");
    await ctl.service.refresh();
    await until(() => fwd.ensured.includes("m-mac"));
    // Next poll sees it running again.
    await ctl.service.refresh();
    expect(ctl.service.machines().find((m) => m.name === "m-mac")?.forwarder?.status).toBe(
      "running",
    );
  });

  test("outdated forwarders are redeployed", async () => {
    const { fwd, ctl } = await setup();
    fwd.states.set("m-vps", { version: "0.0.1", pods: [], unplaced: [] });
    await ctl.service.refresh();
    await until(() => fwd.ensured.includes("m-vps"));
    // Redeployed: the status flips to running without waiting for the next poll.
    expect(ctl.service.machines().find((m) => m.name === "m-vps")?.forwarder?.status).toBe(
      "running",
    );
  });

  test("delete and force delete release the pod's ports", async () => {
    const { fwd, ctl } = await setup();
    const a = (await (
      await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" })
    ).json()) as { id: string };
    const b = (await (
      await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" })
    ).json()) as { id: string };
    await until(() => ctl.service.podList().every((p) => p.state === "running"));
    await ctl.service.refresh();
    await ctl.req("DELETE", `/api/pods/${a.id}`);
    await ctl.service.idle();
    await ctl.req("DELETE", `/api/pods/${b.id}?force=true`);
    expect(fwd.released).toEqual([
      ["m-vps", a.id],
      ["m-vps", b.id],
    ]);
  });

  test("blocks of pods nobody knows about are released", async () => {
    const { fwd, ctl } = await setup();
    fwd.podState("m-vps", "ghost-aaaaaa", [[3000, 7601]]);
    await ctl.service.refresh(); // first refresh: backend listed after machines
    await ctl.service.refresh();
    expect(fwd.released).toContainEqual(["m-vps", "ghost-aaaaaa"]);
  });

  test("repair endpoint; disabled forwarding is a 409", async () => {
    const { fwd, ctl } = await setup();
    const r = await ctl.req("POST", "/api/machines/m-vps/repair");
    expect(r.status).toBe(200);
    expect(fwd.ensured).toContain("m-vps");
    expect((await ctl.req("POST", "/api/machines/m-nope/repair")).status).toBe(404);

    const ws = makeWorkspace();
    const off = await makeController(ws);
    expect((await off.req("POST", "/api/machines/m-vps/repair")).status).toBe(409);
    await off.service.refresh();
    expect(off.service.machines()[0]?.forwarder).toEqual({ status: "disabled" });
  });
});

test("the forwarder bundle runs with plain `bun` and answers /state", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "panem-fwd-bundle-"));
  writeFileSync(join(dir, "forwarder.js"), await forwarderBundle());
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = Bun.spawn(["bun", join(dir, "forwarder.js")], {
    env: {
      PATH: process.env.PATH!,
      PANEM_FORWARDER_TOKEN: "t".repeat(16),
      PANEM_RELAY_SECRET: "r".repeat(16),
      PANEM_PORT_RANGE: `${port + 1}-${port + 10}`,
      PANEM_BLOCK_SIZE: "10",
      PANEM_CONTROL_PORT: String(port),
      PANEM_DATA: dir,
      DOCKER_SOCKET: join(dir, "no-docker.sock"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let body: { version?: string } | undefined;
    for (let i = 0; i < 50 && !body; i++) {
      await Bun.sleep(100);
      body = await fetch(`http://127.0.0.1:${port}/state`, {
        headers: { authorization: `Bearer ${"t".repeat(16)}` },
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ version: string }>) : undefined))
        .catch(() => undefined);
    }
    expect(body?.version).toBe(PANEM_VERSION);
  } finally {
    p.kill();
  }
});
