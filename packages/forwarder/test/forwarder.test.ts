import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Allocator } from "../src/alloc";
import { controlHandler } from "../src/api";
import { Forwarder } from "../src/forwarder";
import { parseList } from "../src/relay";
import { FakeDocker, SECRET, fakeRelay, freePortRange } from "./fakes";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

describe("Allocator", () => {
  test("declared ports first, stable slots, persisted, exhaustion, release", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "alloc-")), "a.json");
    const a = new Allocator([7600, 7619], 10, path);
    expect(a.block("p1")).toBe(7600);
    expect(a.block("p2")).toBe(7610);
    expect(a.block("p3")).toBeUndefined();
    expect(a.assign("p1", [8000], [5173, 3000])).toEqual([]);
    expect(a.slots("p1").map((s) => [s.podPort, s.hostPort])).toEqual([
      [8000, 7601],
      [3000, 7602],
      [5173, 7603],
    ]);
    // A new port later never moves existing ones.
    a.assign("p1", [8000], [1234, 5173]);
    expect(a.slots("p1").find((s) => s.podPort === 1234)?.hostPort).toBe(7604);
    await a.save();

    const b = new Allocator([7600, 7619], 10, path);
    await b.load();
    expect(b.peek("p1")).toBe(7600);
    expect(b.slots("p1").find((s) => s.podPort === 5173)?.hostPort).toBe(7603);
    expect(b.release("p2")).toBe(true);
    expect(b.block("p3")).toBe(7610);
  });

  test("more live ports than slots are reported unmapped", () => {
    const a = new Allocator([7600, 7603], 4, undefined);
    a.block("p");
    expect(a.assign("p", [], [1, 2, 3, 4, 5])).toEqual([4, 5]);
  });

  test("parseList", () => {
    expect(parseList("5173 127.0.0.1\n8000 ::1\n5173 ::\njunk\n")).toEqual([5173, 8000]);
  });
});

async function setup(opts: { blocks?: number } = {}) {
  const blockSize = 5;
  const base = await freePortRange(blockSize * (opts.blocks ?? 2));
  const relayPort = await freePortRange(1);
  const docker = new FakeDocker();
  const alloc = new Allocator([base, base + blockSize * (opts.blocks ?? 2) - 1], blockSize);
  const fwd = new Forwarder({
    docker,
    alloc,
    secret: SECRET,
    blockSize,
    bindHost: "127.0.0.1",
    relayPort,
    log: () => {},
  });
  cleanup.push(() => fwd.stop());
  const pod = (
    id: string,
    ip: string,
    services: Record<number, ReturnType<typeof Bun.serve>>,
    meta = {},
  ) => {
    const listening = new Set(Object.keys(services).map(Number));
    const relay = fakeRelay({
      ip,
      port: relayPort,
      meta: { id, ...meta },
      listening: () => [...listening],
    });
    cleanup.push(() => relay.stop(true));
    docker.add(`c-${id}`, ip);
    return { listening, relay };
  };
  return { fwd, docker, alloc, base, blockSize, pod };
}

function http(body: string) {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, server) => {
      if (server.upgrade(req)) return;
      return new Response(body);
    },
    websocket: {
      message: (ws, m) => {
        ws.send(`echo:${m}`);
      },
    },
  });
  cleanup.push(() => s.stop(true));
  return s;
}

describe("Forwarder", () => {
  test("discovers pods, maps ports, and proxies HTTP and WebSocket", async () => {
    const { fwd, base, pod } = await setup();
    const vite = http("vite here");
    const api = http("api here");
    pod(
      "shop-aaaaaa",
      "127.0.0.2",
      { [vite.port!]: vite, [api.port!]: api },
      {
        ports: { [api.port!]: "api" },
      },
    );
    await fwd.tick();
    const st = fwd.state();
    expect(st.pods).toHaveLength(1);
    const p = st.pods[0]!;
    expect(p.block).toEqual([base, base + 4]);
    // Declared port gets slot 1.
    expect(p.ports[0]).toMatchObject({ slot: 1, podPort: api.port, name: "api", live: true });
    expect(p.ports[1]).toMatchObject({ slot: 2, podPort: vite.port, live: true });

    expect(await (await fetch(`http://127.0.0.1:${base + 1}/`)).text()).toBe("api here");
    expect(await (await fetch(`http://127.0.0.1:${base + 2}/`)).text()).toBe("vite here");
    const index = await (await fetch(`http://127.0.0.1:${base}/`)).text();
    expect(index).toContain("shop-aaaaaa");
    expect(index).toContain(`:${base + 1}`);

    const ws = new WebSocket(`ws://127.0.0.1:${base + 2}/`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (m) => resolve(String(m.data));
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    expect(reply).toBe("echo:hi");
  });

  test("large bodies survive the pipe intact", async () => {
    const { fwd, base, pod } = await setup();
    const big = "x".repeat(4 * 1024 * 1024);
    const s = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => new Response(`${(await req.text()).length}|${big}`),
    });
    cleanup.push(() => s.stop(true));
    pod("big-aaaaaa", "127.0.0.2", { [s.port!]: s });
    await fwd.tick();
    const res = await fetch(`http://127.0.0.1:${base + 1}/`, { method: "POST", body: big });
    const text = await res.text();
    expect(text.length).toBe(big.length + String(big.length).length + 1);
    expect(text.startsWith(`${big.length}|`)).toBe(true);
  });

  test("ignores containers without a relay or with a wrong secret", async () => {
    const { fwd, docker } = await setup();
    docker.add("plain", "127.0.0.9");
    await fwd.tick();
    expect(fwd.state().pods).toEqual([]);
  });

  test("stopped pods keep their block; ports come back on the same numbers", async () => {
    const { fwd, docker, base, pod } = await setup();
    const s = http("ok");
    pod("p-aaaaaa", "127.0.0.2", { [s.port!]: s });
    await fwd.tick();
    expect(fwd.state().pods[0]!.ports[0]!.hostPort).toBe(base + 1);

    docker.remove("c-p-aaaaaa");
    await fwd.tick();
    const stopped = fwd.state().pods[0]!;
    expect(stopped.reachable).toBe(false);
    expect(stopped.ports[0]).toMatchObject({ hostPort: base + 1, live: false });
    await expect(fetch(`http://127.0.0.1:${base + 1}/`)).rejects.toThrow();

    docker.add("c-p-aaaaaa-2", "127.0.0.2");
    await fwd.tick();
    expect(await (await fetch(`http://127.0.0.1:${base + 1}/`)).text()).toBe("ok");
  });

  test("full range leaves new pods unplaced; release frees a block", async () => {
    const { fwd, pod } = await setup({ blocks: 1 });
    const s = http("a");
    pod("one-aaaaaa", "127.0.0.2", { [s.port!]: s });
    pod("two-aaaaaa", "127.0.0.3", { [s.port!]: s });
    await fwd.tick();
    const st = fwd.state();
    expect(st.pods).toHaveLength(1);
    expect(st.unplaced).toHaveLength(1);
    const placed = st.pods[0]!.id;
    expect(await fwd.release(placed)).toBe(true);
    await fwd.tick();
    expect(fwd.state().pods).toHaveLength(1);
  });

  test("control API requires the token", async () => {
    const { fwd, pod } = await setup();
    const s = http("a");
    pod("q-aaaaaa", "127.0.0.2", { [s.port!]: s });
    await fwd.tick();
    const h = controlHandler(fwd, "control-token-0123456789");
    expect((await h(new Request("http://x/state"))).status).toBe(401);
    expect(
      (await h(new Request("http://x/state", { headers: { authorization: "Bearer nope" } })))
        .status,
    ).toBe(401);
    const ok = await h(
      new Request("http://x/state", {
        headers: { authorization: "Bearer control-token-0123456789" },
      }),
    );
    expect(((await ok.json()) as { pods: unknown[] }).pods).toHaveLength(1);
    const del = await h(
      new Request("http://x/pods/q-aaaaaa", {
        method: "DELETE",
        headers: { authorization: "Bearer control-token-0123456789" },
      }),
    );
    expect(await del.json()).toEqual({ released: true });
    expect((await h(new Request("http://x/healthz"))).status).toBe(200);
  });
});
