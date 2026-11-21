/** Client for the in-pod relay (features/claude-code/scripts/relay-conn.sh). */

export interface RelayTarget {
  ip: string;
  port: number;
}

/** Send "<secret> <cmd>" and collect the reply until the relay closes. */
export async function relayAsk(
  t: RelayTarget,
  secret: string,
  cmd: "list" | "meta",
  timeoutMs = 1500,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const done = Promise.withResolvers<void>();
  // Rejections are observed via `await done.promise`; avoid unhandled ones if connect throws first.
  done.promise.catch(() => {});
  let sock: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  const timer = setTimeout(() => {
    sock?.end();
    done.reject(new Error("relay timeout"));
  }, timeoutMs);
  try {
    sock = await Bun.connect({
      hostname: t.ip,
      port: t.port,
      socket: {
        data(_s, d) {
          chunks.push(new Uint8Array(d));
        },
        close() {
          done.resolve();
        },
        error(_s, e) {
          done.reject(e);
        },
        connectError(_s, e) {
          done.reject(e);
        },
      },
    });
    sock.write(`${secret} ${cmd}\n`);
    await done.promise;
  } finally {
    clearTimeout(timer);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** "5173 127.0.0.1\n8000 ::1\n" -> [5173, 8000] */
export function parseList(raw: string): number[] {
  const out = new Set<number>();
  for (const line of raw.split("\n")) {
    const port = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(port) && port > 0 && port < 65536) out.add(port);
  }
  return [...out].sort((a, b) => a - b);
}
