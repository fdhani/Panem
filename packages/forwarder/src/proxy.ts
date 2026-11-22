import type { Socket, TCPSocketListener } from "bun";

/** Where a connection to a host port should go, resolved at connect time. */
export type Route = (hostPort: number) => { ip: string; podPort: number } | undefined;

interface Side {
  peer?: Socket<Side>;
  /** Bytes waiting for this socket to accept them (backpressure). */
  pending: Uint8Array[];
  /** End this socket once pending is flushed. */
  endAfterDrain: boolean;
  closed: boolean;
}

const side = (): Side => ({ pending: [], endAfterDrain: false, closed: false });

function send(s: Socket<Side>, chunk: Uint8Array) {
  const st = s.data;
  if (st.closed) return;
  if (st.pending.length) {
    st.pending.push(chunk);
    return;
  }
  const n = s.write(chunk);
  if (n < chunk.length) st.pending.push(chunk.subarray(Math.max(n, 0)));
}

function flush(s: Socket<Side>) {
  const st = s.data;
  while (st.pending.length) {
    const c = st.pending[0]!;
    const n = s.write(c);
    if (n < c.length) {
      st.pending[0] = c.subarray(Math.max(n, 0));
      return;
    }
    st.pending.shift();
  }
  if (st.endAfterDrain) s.end();
}

function endSoon(s: Socket<Side> | undefined) {
  if (!s || s.data.closed) return;
  if (s.data.pending.length) s.data.endAfterDrain = true;
  else s.end();
}

/**
 * Listens on a host port and pipes every connection to `relay` inside the target pod,
 * after sending "<secret> <podPort>\n". Plain TCP, so WebSockets, SSE and databases work.
 */
export function listenPort(opts: {
  hostname: string;
  port: number;
  route: Route;
  secret: string;
  relayPort: number;
}): TCPSocketListener<Side> {
  return Bun.listen<Side>({
    hostname: opts.hostname,
    port: opts.port,
    socket: {
      open(client) {
        client.data = side();
        const target = opts.route(opts.port);
        if (!target) {
          client.end();
          return;
        }
        // Until upstream is connected, client bytes queue on a placeholder.
        const early: Uint8Array[] = [];
        client.data.peer = undefined;
        (client as unknown as { early?: Uint8Array[] }).early = early;
        Bun.connect<Side>({
          hostname: target.ip,
          port: opts.relayPort,
          socket: {
            open(up) {
              up.data = side();
              if (client.data.closed) {
                up.end();
                return;
              }
              up.data.peer = client;
              client.data.peer = up;
              send(up, new TextEncoder().encode(`${opts.secret} ${target.podPort}\n`));
              for (const c of early) send(up, c);
              early.length = 0;
              if (client.data.endAfterDrain) endSoon(up);
            },
            data(up, chunk) {
              if (up.data.peer) send(up.data.peer, new Uint8Array(chunk));
            },
            drain: flush,
            close(up) {
              up.data.closed = true;
              endSoon(up.data.peer);
            },
            error(up) {
              up.data.closed = true;
              endSoon(up.data.peer);
            },
            connectError() {
              client.end();
            },
          },
        }).catch(() => client.end());
      },
      data(client, chunk) {
        const up = client.data.peer;
        if (up) send(up, new Uint8Array(chunk));
        else (client as unknown as { early: Uint8Array[] }).early.push(new Uint8Array(chunk));
      },
      drain: flush,
      close(client) {
        client.data.closed = true;
        // Client finished sending: let upstream flush, then end it.
        if (client.data.peer) endSoon(client.data.peer);
        else client.data.endAfterDrain = true;
      },
      error(client) {
        client.data.closed = true;
        endSoon(client.data.peer);
      },
    },
  });
}
