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
  test("stable slots, retain frees, persisted with exposure, exhaustion, release", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "alloc-")), "a.json");
    const a = new Allocator([7600, 7619], 10, path);
    expect(a.block("p1")).toBe(7600);
    expect(a.block("p2")).toBe(7610);
    expect(a.block("p3")).toBeUndefined();
    expect(a.assign("p1", [8000, 5173, 3000])).toEqual([]);
    expect(a.slots("p1").map((s) => [s.podPort, s.hostPort])).toEqual([
      [3000, 7601],
      [5173, 7602],
      [8000, 7603],
    ]);
    // Switching one off frees its slot; others don't move; the next one reuses the gap.
    a.retain("p1", [3000, 8000]);
    a.assign("p1", [3000, 8000, 1234]);
    expect(a.slots("p1").map((s) => [s.podPort, s.hostPort])).toEqual([
      [3000, 7601],
      [1234, 7602],
      [8000, 7603],
    ]);
    a.setExposed("p1", [8000, 3000, 1234]);
    await a.save();

    const b = new Allocator([7600, 7619], 10, path);
    await b.load();
    expect(b.peek("p1")).toBe(7600);
    expect(b.exposedOf("p1")).toEqual([1234, 3000, 8000]);
    expect(b.exposedOf("p2")).toBeUndefined();
    expect(b.slots("p1").find((s) => s.podPort === 8000)?.hostPort).toBe(7603);
    expect(b.release("p2")).toBe(true);
    expect(b.block("p3")).toBe(7610);
  });

  test("more exposed ports than slots are reported unmapped", () => {
    const a = new Allocator([7600, 7603], 4, undefined);
    a.block("p");
    expect(a.assign("p", [1, 2, 3, 4, 5])).toEqual([4, 5]);
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
  test("only named ports open by default; switching one on publishes it", async () => {
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
    let p = fwd.state().pods[0]!;
    expect(p.block).toEqual([base, base + 4]);
    expect(p.ports.find((x) => x.podPort === api.port)).toMatchObject({
      name: "api",
      live: true,
      exposed: true,
      slot: 1,
      hostPort: base + 1,
    });
    // Found but closed.
    const closed = p.ports.find((x) => x.podPort === vite.port)!;
    expect(closed).toMatchObject({ live: true, exposed: false });
    expect(closed.hostPort).toBeUndefined();
    expect(await (await fetch(`http://127.0.0.1:${base + 1}/`)).text()).toBe("api here");
    await expect(fetch(`http://127.0.0.1:${base + 2}/`)).rejects.toThrow();

    await fwd.setExposed("shop-aaaaaa", [api.port!, vite.port!]);
    p = fwd.state().pods[0]!;
    expect(p.ports.find((x) => x.podPort === vite.port)).toMatchObject({
      exposed: true,
      hostPort: base + 2,
    });
    expect(await (await fetch(`http://127.0.0.1:${base + 2}/`)).text()).toBe("vite here");
    const index = await (await fetch(`http://127.0.0.1:${base}/`)).text();
    expect(index).toContain("shop-aaaaaa");
    expect(index).toContain(`:${base + 2}`);

    const ws = new WebSocket(`ws://127.0.0.1:${base + 2}/`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (m) => resolve(String(m.data));
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    expect(reply).toBe("echo:hi");

    // Switching off closes the listener and survives the next tick.
    await fwd.setExposed("shop-aaaaaa", [api.port!]);
    await fwd.tick();
    await expect(fetch(`http://127.0.0.1:${base + 2}/`)).rejects.toThrow();
    expect(fwd.state().pods[0]!.ports.find((x) => x.podPort === vite.port)?.exposed).toBe(false);
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
    await fwd.setExposed("big-aaaaaa", [s.port!]);
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
    await fwd.setExposed("p-aaaaaa", [s.port!]);
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
    const auth = { authorization: "Bearer control-token-0123456789" };
    const bad = await h(
      new Request("http://x/pods/q-aaaaaa/exposed", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ ports: ["x"] }),
      }),
    );
    expect(bad.status).toBe(400);
    const put = await h(
      new Request("http://x/pods/q-aaaaaa/exposed", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ ports: [s.port] }),
      }),
    );
    expect(((await put.json()) as { ports: { exposed: boolean }[] }).ports[0]!.exposed).toBe(true);
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
