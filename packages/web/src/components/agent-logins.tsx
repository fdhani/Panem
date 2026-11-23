import type { Machine, MachineLogin } from "@panem/core";
import { KeyRound } from "lucide-react";
import { LOGIN_STATE, machineLabel } from "../lib/agent-login";
import { SignInButton } from "./sign-in";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

interface AgentRow {
  machine: Machine;
  login: MachineLogin;
}

/** Machines' sign-ins regrouped per agent: each agent signs in on its own, once per machine. */
function byAgent(machines: Machine[]) {
  const out = new Map<string, { label: string; loginLabel: string; rows: AgentRow[] }>();
  for (const m of machines) {
    for (const l of m.logins ?? []) {
      const a = out.get(l.agent) ?? { label: l.label, loginLabel: l.loginLabel, rows: [] };
      a.rows.push({ machine: m, login: l });
      out.set(l.agent, a);
    }
  }
  return [...out.entries()];
}

/**
 * Agent sign-ins, one block per agent (any agent with a sign-in): where it's signed in, and a
 * button that signs it in on a machine.
 */
export function AgentSignIns({ machines }: { machines: Machine[] }) {
  const agents = byAgent(machines);
  if (agents.length === 0) return null;
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="flex items-center gap-2 font-medium">
          <KeyRound className="size-4 text-muted" /> Agent sign-ins
        </h2>
        <p className="mt-1 text-xs text-muted">
          Each agent signs in with its own account, once per machine; every pod on that machine then
          uses it. Sign-ins aren't copied between machines.
        </p>
      </div>
      {agents.map(([id, a]) => (
        <section key={id} className="flex flex-col gap-2" aria-label={a.label}>
          <h3 className="text-sm font-medium">{a.label}</h3>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {a.rows.map((r) => (
              <AgentMachineRow key={r.machine.name} row={r} loginLabel={a.loginLabel} />
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}

function AgentMachineRow({ row, loginLabel }: { row: AgentRow; loginLabel: string }) {
  const { machine, login } = row;
  const st = LOGIN_STATE[login.state];
  const where = machineLabel(machine.name);
  const own = login.pods.filter((p) => p.shared === false);
  const canSignIn = login.state !== "no-pods" && machine.status !== "offline";
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <span className="font-mono text-sm">{where}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {canSignIn && (
          <span className="ml-auto">
            <SignInButton
              scope={{ machine: machine.name, agent: login.agent, label: loginLabel }}
              variant={login.state === "signed-in" ? "ghost" : "primary"}
              title={`${loginLabel} on ${where}, for every pod there`}
            >
              {login.state === "signed-in" ? "Sign in again" : loginLabel}
            </SignInButton>
          </span>
        )}
      </div>
      {login.state === "no-pods" && (
        <p className="text-xs text-muted">Summon a pod on {where} to sign in from.</p>
      )}
      {machine.status === "offline" && login.state !== "no-pods" && (
        <p className="text-xs text-muted">{where} is offline.</p>
      )}
      {own.length > 0 && (
        <p className="text-xs break-words text-warn">
          {own.length === 1 ? "1 pod" : `${own.length} pods`} can't use this sign-in:{" "}
          {own[0]!.reason ?? "see the pod's agent page"}
        </p>
      )}
    </li>
  );
}
