/**
 * Agents' sign-ins, per machine. Works for any agent whose agent.json has a "login" block: the
 * controller never knows which agent it is, only its id, labels and reported status.
 *
 * - machineLogins() and pickLoginPod() (in @panem/core): each agent's sign-in state on a
 *   machine, worked out from its pods, and the pod a sign-in runs in.
 * - LoginSessions: runs an agent's own sign-in command in a pod under a terminal (PTY) and
 *   passes it to the browser over a WebSocket. Panem never reads, logs or keeps what goes
 *   through: the person completes the agent's own flow in it, as they would over SSH.
 */
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket, Subprocess, WebSocketHandler } from "bun";

export interface LoginTarget {
  machine: string;
  agent: string;
  pod: string;
}

/** What the browser receives as text frames (terminal output arrives as binary frames). */
export type LoginEvent =
  | { type: "exit"; code: number }
  | { type: "done"; restarted: string[] }
  | { type: "error"; message: string };

export interface LoginWsData {
  target: LoginTarget;
  run: { argv: string[]; env: Record<string, string> };
}

interface Live {
  proc?: Subprocess;
  idle?: Timer;
}

export const LOGIN_WS_PATH = "/api/logins/ws";
const TICKET_MS = 60_000;

export interface LoginSessionsOptions {
  /** What runs the agent's sign-in in the pod, interactively (backend.interactiveArgv). */
  command(target: LoginTarget): { argv: string[]; env: Record<string, string> };
  /** After a sign-in finished well: restart the agent where it waits for one. */
  signedIn(target: LoginTarget): Promise<{ restarted: string[] }>;
  /** A session with no input or output for this long is closed (default 10 minutes). */
  idleMs?: number;
}

export class LoginSessions {
  private tickets = new Map<string, { target: LoginTarget; expires: number }>();
  /** Sessions in progress, one per machine and agent. */
  private live = new Map<string, Live>();
  readonly websocket: WebSocketHandler<LoginWsData>;

  constructor(private readonly o: LoginSessionsOptions) {
    this.websocket = {
      open: (ws) => this.open(ws),
      message: (ws, m) => this.message(ws, m),
      close: (ws) => this.close(ws),
    };
  }

  /** A one-time ticket (valid for a minute) to open the session's WebSocket. */
  issue(target: LoginTarget): string {
    if (this.live.has(key(target))) {
      throw new Error(`a sign-in for ${target.agent} on ${target.machine} is already open`);
    }
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.expires < now) this.tickets.delete(t);
    const ticket = randomBytes(24).toString("hex");
    this.tickets.set(ticket, { target, expires: now + TICKET_MS });
    return ticket;
  }

  /**
   * For Bun.serve's fetch: false when the request isn't for a sign-in session, a Response when
   * it's refused, undefined once upgraded to a WebSocket.
   */
  upgrade(req: Request, server: Server<LoginWsData>): Response | undefined | false {
    const url = new URL(req.url);
    if (url.pathname !== LOGIN_WS_PATH) return false;
    const ticket = url.searchParams.get("ticket") ?? "";
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expires < Date.now()) return new Response("unauthorized", { status: 401 });
    if (this.live.has(key(t.target))) return new Response("already open", { status: 409 });
    this.live.set(key(t.target), {});
    const ok = server.upgrade(req, { data: { target: t.target, run: this.o.command(t.target) } });
    if (!ok) {
      this.live.delete(key(t.target));
      return new Response("expected a WebSocket", { status: 400 });
    }
    return undefined;
  }

  private open(ws: ServerWebSocket<LoginWsData>) {
    const live = this.live.get(key(ws.data.target)) ?? {};
    this.live.set(key(ws.data.target), live);
    const send = (e: LoginEvent) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(e));
    };
    const touch = () => {
      if (live.idle) clearTimeout(live.idle);
      live.idle = setTimeout(() => ws.close(1000, "idle"), this.o.idleMs ?? 10 * 60_000);
    };
    touch();
    try {
      live.proc = Bun.spawn(ws.data.run.argv, {
        env: { ...process.env, ...ws.data.run.env, TERM: "xterm-256color" },
        terminal: {
          cols: 100,
          rows: 30,
          data: (_t, d) => {
            touch();
            if (ws.readyState === 1) ws.sendBinary(d);
          },
        },
      });
    } catch (e) {
      send({ type: "error", message: `couldn't start the sign-in: ${(e as Error).message}` });
      ws.close();
      return;
    }
    const proc = live.proc;
    void proc.exited.then(async (code) => {
      // Let the last output reach the browser before saying it ended.
      await Bun.sleep(50);
      send({ type: "exit", code });
      if (code === 0) {
        try {
          send({ type: "done", ...(await this.o.signedIn(ws.data.target)) });
        } catch (e) {
          send({ type: "error", message: (e as Error).message });
        }
      }
      ws.close(1000, "done");
    });
  }

  private message(ws: ServerWebSocket<LoginWsData>, m: string | Buffer) {
    const live = this.live.get(key(ws.data.target));
    const term = live?.proc?.terminal;
    if (!term) return;
    // Keystrokes come as binary frames; text frames are control messages.
    if (typeof m !== "string") {
      term.write(m);
      return;
    }
    try {
      const c = JSON.parse(m) as { resize?: [number, number] };
      const [cols, rows] = c.resize ?? [];
      if (cols && rows && cols > 0 && rows > 0 && cols < 1000 && rows < 1000) {
        term.resize(Math.floor(cols), Math.floor(rows));
      }
    } catch {
      // Not a control message: ignored.
    }
  }

  private close(ws: ServerWebSocket<LoginWsData>) {
    const k = key(ws.data.target);
    const live = this.live.get(k);
    this.live.delete(k);
    if (live?.idle) clearTimeout(live.idle);
    // Closing the browser ends the sign-in.
    if (live?.proc && live.proc.exitCode === null) live.proc.kill();
    live?.proc?.terminal?.close();
  }

  /** Sign-ins in progress (machine:agent), for tests. */
  inProgress(): string[] {
    return [...this.live.keys()];
  }
}

const key = (t: LoginTarget) => `${t.machine}:${t.agent}`;
