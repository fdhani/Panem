import type { ContainerInfo, DockerApi } from "../src/docker";

export const SECRET = "relay-secret-0123456789";

export class FakeDocker implements DockerApi {
  containers: ContainerInfo[] = [];
  joined: [string, string][] = [];
  async running() {
    return this.containers;
  }
  async connectNetwork(net: string, container: string) {
    this.joined.push([net, container]);
  }
  add(id: string, ip: string, labels: Record<string, string> = {}, net = "bridge") {
    this.containers.push({ id, name: id, labels, networks: new Map([[net, ip]]) });
  }
  remove(id: string) {
    this.containers = this.containers.filter((c) => c.id !== id);
  }
}

/** write() with a queue, so the fake relay respects backpressure like socat does. */
function writer(sock: { write(d: Uint8Array): number; end(): void }) {
  const q: Uint8Array[] = [];
  let ending = false;
  return {
    write(d: Uint8Array) {
      if (q.length) return void q.push(d);
      const n = sock.write(d);
      if (n < d.length) q.push(d.subarray(Math.max(n, 0)));
    },
    drain() {
      while (q.length) {
        const c = q[0]!;
        const n = sock.write(c);
        if (n < c.length) {
          q[0] = c.subarray(Math.max(n, 0));
          return;
        }
        q.shift();
      }
      if (ending) sock.end();
    },
    end() {
      if (q.length) ending = true;
      else sock.end();
    },
  };
}

/**
 * TypeScript stand-in for relay-conn.sh: same protocol, pipes to servers on 127.0.0.1.
 */
export function fakeRelay(opts: {
  ip: string;
  port: number;
  meta: Record<string, unknown>;
  listening: () => number[];
}) {
  type W = ReturnType<typeof writer>;
  type St = { buf: string; up?: W; queue: Uint8Array[]; out: W };
  return Bun.listen<St>({
    hostname: opts.ip,
    port: opts.port,
    socket: {
      open(s) {
        s.data = { buf: "", queue: [], out: writer(s) };
      },
      drain(s) {
        s.data.out.drain();
      },
      data(s, chunk) {
        if (s.data.up) {
          s.data.up.write(new Uint8Array(chunk));
          return;
        }
        if (s.data.queue.length || s.data.buf.includes("\n")) {
          s.data.queue.push(new Uint8Array(chunk));
          return;
        }
        const text = new TextDecoder().decode(chunk);
        const nl = text.indexOf("\n");
        if (nl < 0) {
          s.data.buf += text;
          return;
        }
        const line = s.data.buf + text.slice(0, nl);
        s.data.buf = line;
        const rest = new Uint8Array(chunk).subarray(Buffer.byteLength(text.slice(0, nl + 1)));
        const [secret, cmd] = line.split(" ");
        if (secret !== SECRET) return void s.end();
        if (cmd === "list")
          return void s.end(
            opts
              .listening()
              .map((p) => `${p} 127.0.0.1\n`)
              .join(""),
          );
        if (cmd === "meta") return void s.end(JSON.stringify(opts.meta));
        const port = Number(cmd);
        if (!opts.listening().includes(port)) return void s.end();
        if (rest.length) s.data.queue.push(rest);
        Bun.connect<{ w: W }>({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(up) {
              up.data = { w: writer(up) };
              s.data.up = up.data.w;
              for (const q of s.data.queue) up.data.w.write(q);
              s.data.queue = [];
            },
            drain(up) {
              up.data.w.drain();
            },
            data(_up, d) {
              s.data.out.write(new Uint8Array(d));
            },
            close() {
              s.data.out.end();
            },
            error() {
              s.data.out.end();
            },
          },
        }).catch(() => s.end());
      },
      close(s) {
        s.data.up?.end();
      },
    },
  });
}

export async function freePortRange(size: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    const opened: { stop(b?: boolean): void }[] = [];
    try {
      for (let p = base; p < base + size; p++) {
        opened.push(Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }));
      }
      return base;
    } catch {
      // collision, try another base
    } finally {
      for (const o of opened) o.stop(true);
    }
  }
  throw new Error("no free port range");
}
