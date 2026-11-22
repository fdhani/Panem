// Forwarder against the real relay-conn.sh under socat (what runs inside pods).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Allocator } from "../src/alloc";
import { Forwarder } from "../src/forwarder";
import { FakeDocker, SECRET, freePortRange } from "./fakes";

const hasSocat = Bun.which("socat") !== null;
const procs: { kill(): void }[] = [];
const stops: (() => void)[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const s of stops) s();
});

test.skipIf(!hasSocat)("end to end through socat relay-conn.sh", async () => {
  const ws = mkdtempSync(join(tmpdir(), "panem-real-relay-"));
  mkdirSync(join(ws, ".panem"));
  writeFileSync(join(ws, ".panem/pod.json"), JSON.stringify({ id: "real-aaaaaa", ports: {} }));
  const relayPort = await freePortRange(1);
  const script = join(import.meta.dir, "../../../features/src/panem/scripts/relay-conn.sh");
  procs.push(
    Bun.spawn(
      ["socat", `TCP-LISTEN:${relayPort},bind=127.0.0.7,fork,reuseaddr`, `SYSTEM:${script}`],
      {
        env: {
          ...process.env,
          PANEM_RELAY_SECRET: SECRET,
          PANEM_STATE_DIR: join(ws, ".panem"),
          PANEM_RELAY_PORT: String(relayPort),
        },
        stderr: "ignore",
      },
    ),
  );
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("from pod") });
  stops.push(() => app.stop(true));

  const base = await freePortRange(100);
  const docker = new FakeDocker();
  docker.add("c-real", "127.0.0.7");
  const fwd = new Forwarder({
    docker,
    alloc: new Allocator([base, base + 99], 100),
    secret: SECRET,
    blockSize: 100,
    bindHost: "127.0.0.1",
    relayPort,
    log: () => {},
  });
  stops.push(() => fwd.stop());
  for (let i = 0; i < 40 && fwd.state().pods.length === 0; i++) {
    await Bun.sleep(50);
    await fwd.tick();
  }
  await fwd.setExposed("real-aaaaaa", [app.port!]);
  // This host's /proc/net/tcp lists every local listener; find ours.
  const mapped = fwd.state().pods[0]!.ports.find((p) => p.podPort === app.port);
  expect(mapped?.live).toBe(true);
  expect(await (await fetch(`http://127.0.0.1:${mapped!.hostPort}/`)).text()).toBe("from pod");
});
