import type { MachineLogin } from "@panem/core";
import { api } from "./api";

/**
 * Signing an agent in, for any agent whose agent.json has a "login" block. A sign-in is per
 * machine: it runs the agent's own sign-in in one of the machine's pods, and every pod there
 * that waits for it restarts. `pod` signs in that pod only (one that can't share).
 */
export interface LoginScope {
  machine: string;
  agent: string;
  /** The agent's sign-in label (agent.json "login.label"), e.g. "Sign in to Claude". */
  label: string;
  pod?: string;
}

/** What the sign-in terminal reports (text frames; output arrives as binary frames). */
export type LoginEvent =
  | { type: "exit"; code: number }
  | { type: "done"; restarted: string[] }
  | { type: "error"; message: string };

/** Ask for a sign-in session: the pod it runs in and a one-time ticket for its terminal. */
export function startLogin(s: LoginScope): Promise<{ ticket: string; pod: string }> {
  return api(
    "POST",
    `/api/machines/${encodeURIComponent(s.machine)}/logins/${encodeURIComponent(s.agent)}`,
    s.pod ? { pod: s.pod } : {},
  );
}

export function loginSocketUrl(ticket: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/logins/ws?ticket=${encodeURIComponent(ticket)}`;
}

/** How a machine's sign-in state is shown. */
export const LOGIN_STATE: Record<
  MachineLogin["state"],
  { label: string; tone: "ok" | "warn" | "bad" | "muted" }
> = {
  "signed-in": { label: "Signed in", tone: "ok" },
  "needs-sign-in": { label: "Needs sign-in", tone: "warn" },
  "no-pods": { label: "No running pod", tone: "muted" },
  unknown: { label: "Check pods", tone: "muted" },
};

export const machineLabel = (name: string) => name.replace(/^m-/, "");
