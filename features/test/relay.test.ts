// Exercises relay-conn.sh behind a real socat listener, as the forwarder would use it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasSocat = Bun.which("socat") !== null;
const scripts = join(import.meta.dir, "../src/panem/scripts");
const SECRET = "relay-secret-123";
const root = mkdtempSync(join(tmpdir(), "panem-relay-"));
let relayPort = 0;
let relay: ReturnType<typeof Bun.spawn> | undefined;
let v4: ReturnType<typeof Bun.serve> | undefined;
let v6: ReturnType<typeof Bun.serve> | undefined;

/** Send one protocol line (plus optional payload) and collect the reply until close. */
async function ask(line: string, payload = "", timeoutMs = 3000): Promise<string> {
  let out = "";
  const done = Promise.withResolvers<void>();
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port: relayPort,
    socket: {
      data(_s, d) {
        out += new TextDecoder().decode(d);
      },
      close() {
        done.resolve();
      },
      error() {
        done.resolve();
      },
    },
  });
  sock.write(`${line}\n${payload}`);
  const timer = setTimeout(() => sock.end(), timeoutMs);
  await done.promise;
  clearTimeout(timer);
  return out;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

beforeAll(async () => {
  if (!hasSocat) return;
  mkdirSync(join(root, ".panem"), { recursive: true });
  writeFileSync(join(root, ".panem/pod.json"), '{"id":"shop-abc123"}\n');
  v4 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello v4") });
  try {
    v6 = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("hello v6") });
  } catch {
    // No IPv6 on this host: the ::1 cases are skipped.
  }
  relayPort = await freePort();
  relay = Bun.spawn(
    [
      "socat",
      `TCP-LISTEN:${relayPort},bind=127.0.0.1,fork,reuseaddr`,
      `SYSTEM:${scripts}/relay-conn.sh`,
    ],
    {
      env: {
        ...process.env,
        PANEM_RELAY_SECRET: SECRET,
        PANEM_STATE_DIR: join(root, ".panem"),
        PANEM_RELAY_PORT: String(relayPort),
      },
      stderr: "ignore",
    },
  );
  for (let i = 0; i < 50; i++) {
    try {
      (await Bun.connect({ hostname: "127.0.0.1", port: relayPort, socket: { data() {} } })).end();
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
});

afterAll(() => {
  relay?.kill();
  v4?.stop(true);
  v6?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasSocat)("relay", () => {
  test("wrong or missing secret gets nothing", async () => {
    expect(await ask("nope list")).toBe("");
    expect(await ask("list")).toBe("");
  });

  test("list reports IPv4 and IPv6 loopback listeners, not itself", async () => {
    const lines = (await ask(`${SECRET} list`)).trim().split("\n");
    expect(lines).toContain(`${v4!.port} 127.0.0.1`);
    if (v6) expect(lines).toContain(`${v6.port} ::1`);
    expect(lines.some((l) => l.startsWith(`${relayPort} `))).toBe(false);
  });

  test("meta returns pod.json", async () => {
    expect(JSON.parse(await ask(`${SECRET} meta`)).id).toBe("shop-abc123");
  });

  test("pipes to loopback-only servers on both stacks", async () => {
    const req = (port: number) =>
      ask(`${SECRET} ${port}`, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(await req(v4!.port)).toContain("hello v4");
    if (v6) expect(await req(v6.port)).toContain("hello v6");
  });

  test("refuses ports nobody listens on, garbage, and the relay itself", async () => {
    const dead = await freePort();
    expect(await ask(`${SECRET} ${dead}`)).toBe("");
    expect(await ask(`${SECRET} 80;rm -rf /`)).toBe("");
    expect(await ask(`${SECRET} ${relayPort}`)).toBe("");
  });
});
