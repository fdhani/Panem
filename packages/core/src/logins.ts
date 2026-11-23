import type { MachineLogin, Pod } from "./schemas";

// Agents' sign-ins per machine, for any agent whose agent.json has a "login" block. Used by the
// controller (machine state, where a sign-in runs) and the CLI.

/** Each agent with a sign-in, on one machine, from that machine's pods. */
export function machineLogins(machine: string, pods: Pod[]): MachineLogin[] {
  const out = new Map<string, MachineLogin>();
  for (const p of pods.filter((x) => x.machine === machine)) {
    for (const a of p.agents ?? []) {
      if (!a.login) continue;
      const entry = out.get(a.id) ?? {
        agent: a.id,
        label: a.label || a.id,
        loginLabel: a.login.label,
        state: "no-pods" as const,
        pods: [],
      };
      out.set(a.id, entry);
      if (p.state !== "running") continue;
      entry.pods.push({
        id: p.id,
        state: a.status?.state,
        shared: a.login.shared,
        reason: a.login.reason,
      });
    }
  }
  for (const e of out.values()) e.state = loginState(e.pods);
  return [...out.values()];
}

function loginState(pods: MachineLogin["pods"]): MachineLogin["state"] {
  if (pods.length === 0) return "no-pods";
  // A pod that keeps its own sign-in (shared: false) says nothing about the machine's.
  const machinePods = pods.filter((p) => p.shared !== false);
  if (machinePods.some((p) => p.state === "running")) return "signed-in";
  if (pods.some((p) => p.state === "needs-login")) return "needs-sign-in";
  return "unknown";
}

/**
 * The pod to run a machine sign-in in: one using the machine's sign-in (so the result is
 * shared), waiting for a sign-in if possible. Undefined when no running pod has the agent.
 */
export function pickLoginPod(machine: string, agent: string, pods: Pod[]): string | undefined {
  const e = machineLogins(machine, pods).find((l) => l.agent === agent);
  const rank = (p: MachineLogin["pods"][number]) =>
    (p.shared === false ? 2 : 0) + (p.state === "needs-login" ? 0 : 1);
  return e?.pods.slice().sort((a, b) => rank(a) - rank(b))[0]?.id;
}
