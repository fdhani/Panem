import type { Machine, MachineLogin, Pod } from "@panem/core";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { LOGIN_STATE, machineLabel } from "../lib/agent-login";
import { AGENT_STATE } from "../lib/agent-state";
import { SignInButton } from "./sign-in";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

/** Agents on a machine that wait for a sign-in (for a compact hint in lists). */
export function agentsNeedingSignIn(m: Machine): MachineLogin[] {
  return (m.logins ?? []).filter((l) => l.state === "needs-sign-in");
}

/**
 * A machine's agents, one card per agent (any agent with a sign-in): its sign-in on this
 * machine, a button to sign it in, and how it's doing in each of the machine's pods.
 */
export function MachineAgents({ machine, pods }: { machine: Machine; pods: Pod[] }) {
  const logins = machine.logins ?? [];
  if (logins.length === 0) {
    return <p className="text-sm text-muted">No agents with a sign-in on this machine.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {logins.map((l) => (
        <AgentCard key={l.agent} machine={machine} login={l} pods={pods} />
      ))}
    </div>
  );
}

function AgentCard({
  machine,
  login,
  pods,
}: {
  machine: Machine;
  login: MachineLogin;
  pods: Pod[];
}) {
  const st = LOGIN_STATE[login.state];
  const where = machineLabel(machine.name);
  const canSignIn = login.state !== "no-pods" && machine.status !== "offline";
  // Every pod here that has this agent, running or not, with the agent's own state.
  const withAgent = pods
    .filter((p) => p.machine === machine.name)
    .flatMap((p) => {
      const a = p.agents?.find((x) => x.id === login.agent);
      return a ? [{ pod: p, agent: a }] : [];
    });
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-medium">{login.label}</h3>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        {canSignIn && (
          <div className="shrink-0">
            <SignInButton
              scope={{ machine: machine.name, agent: login.agent, label: login.loginLabel }}
              variant={login.state === "signed-in" ? "ghost" : "primary"}
              title={`${login.loginLabel} on ${where}, for every pod there`}
            >
              {login.state === "signed-in" ? "Sign in again" : "Sign in"}
            </SignInButton>
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        {login.state === "no-pods"
          ? `Summon a pod on ${where} to sign ${login.label} in from. One sign-in then serves every pod here.`
          : `${login.label} signs in with its own account, once for ${where}: every pod here uses it. It isn't copied to other machines.`}
        {machine.status === "offline" && ` ${where} is offline.`}
      </p>
      {withAgent.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {withAgent.map(({ pod, agent }) => {
            const ast = agent.status ? AGENT_STATE[agent.status.state] : undefined;
            const own = agent.login?.shared === false;
            return (
              <li key={pod.id}>
                <Link
                  to="/pods/$id/agents/$agent"
                  params={{ id: pod.id, agent: agent.id }}
                  className="flex flex-col gap-1 px-3 py-2.5 hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm">{pod.id}</span>
                    {pod.state !== "running" ? (
                      <Badge>{pod.state}</Badge>
                    ) : ast ? (
                      <Badge tone={ast.tone}>{ast.label}</Badge>
                    ) : (
                      <Badge>Unknown</Badge>
                    )}
                    <ChevronRight className="size-4 shrink-0 text-muted" />
                  </span>
                  {own && (
                    <span className="text-xs break-words text-warn">
                      Can't use {where}'s sign-in: {agent.login?.reason ?? "see its page"}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
