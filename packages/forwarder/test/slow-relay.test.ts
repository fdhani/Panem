import { afterEach, describe, expect, test } from "bun:test";
import { Allocator } from "../src/alloc";
import { Forwarder, NOT_A_POD_RETRY_MS } from "../src/forwarder";
import { type Connect, relayAsk } from "../src/relay";
import { FakeDocker, SECRET, fakeRelay, freePortRange } from "./fakes";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** A connect that never completes, like one to a container on a network we can't reach. */
const hanging = (() => new Promise(() => {})) as unknown as Connect;

describe("relayAsk time limit", () => {
  test("covers a connect that never completes", async () => {
    const t0 = Date.now();
    await expect(
      relayAsk({ ip: "172.25.0.2", port: 7699 }, SECRET, "meta", 200, hanging),
    ).rejects.toThrow("relay timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a socket that connects after the time limit is closed at once", async () => {
    let ended = false;
    const late = ((): Promise<unknown> =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              write() {},
              end() {
                ended = true;
              },
            }),
          300,
        ),
      )) as unknown as Connect;
    await expect(relayAsk({ ip: "10.0.0.1", port: 1 }, SECRET, "list", 100, late)).rejects.toThrow(
      "relay timeout",
    );
    await Bun.sleep(400);
    expect(ended).toBe(true);
  });
});

async function setup(connect: Connect, selfId?: string, notAPodRetryMs?: number) {
  const base = await freePortRange(10);
  const relayPort = await freePortRange(1);
  const docker = new FakeDocker();
  const fwd = new Forwarder({
    docker,
    alloc: new Allocator([base, base + 9], 5),
    secret: SECRET,
    blockSize: 5,
    bindHost: "127.0.0.1",
    relayPort,
    selfId,
    connect,
    notAPodRetryMs,
    log: () => {},
  });
  cleanup.push(() => fwd.stop());
  return { fwd, docker, relayPort };
}

describe("a new pod is found soon after its relay starts", () => {
  test("a container that didn't answer is asked again after the retry interval", async () => {
    expect(NOT_A_POD_RETRY_MS).toBeLessThanOrEqual(5_000);
    const { fwd, docker, relayPort } = await setup(Bun.connect, undefined, 150);
    docker.add("c1", "127.0.0.3");
    await fwd.tick(); // the container exists; its relay doesn't run yet (setup is still going)
    expect(fwd.state().pods).toEqual([]);
    const relay = fakeRelay({
      ip: "127.0.0.3",
      port: relayPort,
      meta: { id: "shop-bbbbbb" },
      listening: () => [],
    });
    cleanup.push(() => relay.stop(true));
    await fwd.tick(); // too soon: not asked again yet
    expect(fwd.state().pods).toEqual([]);
    await Bun.sleep(200);
    await fwd.tick();
    expect(fwd.state().pods.map((p) => p.id)).toEqual(["shop-bbbbbb"]);
  });
});

describe("ticks stay short", () => {
  test("one unreachable container doesn't hold up the tick or hide other pods", async () => {
    const seen: string[] = [];
    const connect = ((o: { hostname: string }) => {
      seen.push(o.hostname);
      return o.hostname === "127.0.0.9" ? new Promise(() => {}) : Bun.connect(o as never);
    }) as unknown as Connect;
    const { fwd, docker, relayPort } = await setup(connect);
    const relay = fakeRelay({
      ip: "127.0.0.2",
      port: relayPort,
      meta: { id: "shop-aaaaaa" },
      listening: () => [],
    });
    cleanup.push(() => relay.stop(true));
    docker.add("c-ok", "127.0.0.2");
    docker.add("c-stuck", "127.0.0.9");
    const t0 = Date.now();
    await fwd.tick();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(fwd.state().pods.map((p) => p.id)).toEqual(["shop-aaaaaa"]);
    expect(seen).toContain("127.0.0.9");
  });

  test("containers that aren't devcontainers are never probed", async () => {
    const seen: string[] = [];
    const connect = ((o: { hostname: string }) => {
      seen.push(o.hostname);
      return new Promise(() => {});
    }) as unknown as Connect;
    const { fwd, docker } = await setup(connect);
    docker.add("postgres", "172.25.0.2", { "com.docker.compose.project": "core" }, "core_default");
    docker.add("plain", "172.17.0.5", {});
    const t0 = Date.now();
    await fwd.tick();
    expect(seen).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("a pod is reached on a network the forwarder could join", async () => {
    const seen: string[] = [];
    const connect = ((o: { hostname: string }) => {
      seen.push(o.hostname);
      return new Promise(() => {});
    }) as unknown as Connect;
    const { fwd, docker } = await setup(connect, "self");
    docker.refuse.add("host-only");
    docker.containers.push({
      id: "c-pod",
      name: "c-pod",
      labels: { "dev.containers.id": "x" },
      networks: new Map([
        ["host-only", "172.30.0.4"],
        ["devpod-net", "172.31.0.4"],
      ]),
    });
    await fwd.tick();
    expect(seen).toEqual(["172.31.0.4"]);
  });
});
