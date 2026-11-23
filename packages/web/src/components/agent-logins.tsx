import type { Machine } from "@panem/core";
import { LOGIN_STATE, machineLabel } from "../lib/agent-login";
import { SignInButton } from "./sign-in";
import { Badge } from "./ui/badge";

/** A machine's agent sign-ins: one row per agent that has a sign-in (any agent). */
export function AgentLogins({ machine }: { machine: Machine }) {
  const logins = machine.logins ?? [];
  if (logins.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {logins.map((l) => {
        const st = LOGIN_STATE[l.state];
        const own = l.pods.filter((p) => p.shared === false);
        return (
          <li key={l.agent} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{l.label}</span>
              <Badge tone={st.tone}>{st.label}</Badge>
              {l.state !== "no-pods" && machine.status !== "offline" && (
                <span className="ml-auto">
                  <SignInButton
                    scope={{ machine: machine.name, agent: l.agent, label: l.loginLabel }}
                    variant={l.state === "signed-in" ? "ghost" : "primary"}
                  >
                    {l.state === "signed-in" ? "Sign in again" : "Sign in"}
                  </SignInButton>
                </span>
              )}
            </div>
            {l.state === "no-pods" && (
              <p className="text-xs text-muted">
                Summon a pod on {machineLabel(machine.name)} to sign in from.
              </p>
            )}
            {own.length > 0 && (
              <p className="text-xs break-words text-warn">
                {own.length === 1 ? "1 pod" : `${own.length} pods`} can't use this sign-in:{" "}
                {own[0]!.reason ?? "see the pod's agent page"}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
