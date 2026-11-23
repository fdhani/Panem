/** Client for the in-pod relay (features/claude-code/scripts/relay-conn.sh). */

export interface RelayTarget {
  ip: string;
  port: number;
}

export type Connect = typeof Bun.connect;

/**
 * Send "<secret> <cmd>" and collect the reply until the relay closes. The time limit covers the
 * whole exchange, connecting included: to a container on a network this forwarder can't reach,
 * a connect can hang for minutes, so it's raced against the timer, and a socket that connects
 * after giving up is closed at once.
 */
export async function relayAsk(
  t: RelayTarget,
  secret: string,
  cmd: "list" | "meta",
  timeoutMs = 1500,
  connect: Connect = Bun.connect,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const done = Promise.withResolvers<void>();
  done.promise.catch(() => {});
  let sock: Awaited<ReturnType<Connect>> | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      sock?.end();
      reject(new Error("relay timeout"));
    }, timeoutMs);
  });
  timeout.catch(() => {});
  try {
    const connecting = connect({
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
    // Connected only after we gave up: don't leave the socket open.
    connecting.then((s) => timedOut && s.end()).catch(() => {});
    sock = await Promise.race([connecting, timeout]);
    sock.write(`${secret} ${cmd}\n`);
    await Promise.race([done.promise, timeout]);
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
