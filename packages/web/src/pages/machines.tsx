import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { agentsNeedingSignIn } from "../components/agent-logins";
import { MachineDot } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, Input } from "../components/ui/field";
import { api, keys, queryClient, useMachines, usePods } from "../lib/api";
import { ForwarderBadge } from "./machine";
import { QueryError } from "./shared";

export function MachinesPage() {
  const machines = useMachines();
  const pods = usePods();
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.machines });
  const add = useMutation({
    mutationFn: () => api("POST", "/api/machines", { host, user: user || undefined }),
    onSuccess: () => {
      setHost("");
      setUser("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (name: string) => api("DELETE", `/api/machines/${name}`),
    onSettled: refresh,
  });

  if (machines.error) return <QueryError error={machines.error} />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Machines</h1>
      <Card className="divide-y divide-border">
        {machines.data?.length === 0 && (
          <p className="p-4 text-sm text-muted">No machines yet. Add one below.</p>
        )}
        {machines.data?.map((m) => {
          const count = pods.data?.filter((p) => p.machine === m.name).length ?? 0;
          const waiting = agentsNeedingSignIn(m);
          return (
            <div key={m.name} className="flex items-center gap-1 pr-2">
              <Link
                to="/machines/$name"
                params={{ name: m.name }}
                className="flex min-w-0 flex-1 items-center gap-3 p-4 hover:bg-surface-2"
              >
                <MachineDot status={m.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.name.replace(/^m-/, "")}</p>
                  <p className="truncate font-mono text-xs text-muted">
                    {m.user ? `${m.user}@` : ""}
                    {m.host} · {m.status} · {count} pod{count === 1 ? "" : "s"}
                  </p>
                  {(waiting.length > 0 || (m.forwarder && m.forwarder.status !== "disabled")) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {m.forwarder && m.forwarder.status !== "disabled" && (
                        <ForwarderBadge f={m.forwarder} />
                      )}
                      {waiting.map((l) => (
                        <Badge key={l.agent} tone="warn">
                          {l.label}: needs sign-in
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </Link>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${m.name}`}
                disabled={count > 0 || remove.isPending}
                title={count > 0 ? "Delete its pods first" : "Remove machine"}
                onClick={() => remove.mutate(m.name)}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
      </Card>
      {remove.error && <p className="text-sm text-bad">{remove.error.message}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Card className="flex flex-col gap-4 p-4">
          <h2 className="font-medium">Add a machine</h2>
          <Field
            label="Tailscale hostname"
            htmlFor="host"
            hint="Needs Docker and SSH access from the controller. Use “local” for the controller's own Docker."
          >
            <Input
              id="host"
              value={host}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="vps"
              onChange={(e) => setHost(e.target.value)}
              required
            />
          </Field>
          <Field label="SSH user (optional)" htmlFor="user">
            <Input
              id="user"
              value={user}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="dev"
              onChange={(e) => setUser(e.target.value)}
            />
          </Field>
          {add.error && <p className="text-sm text-bad">{add.error.message}</p>}
          <Button type="submit" variant="primary" disabled={!host || add.isPending}>
            <Plus /> Add machine
          </Button>
        </Card>
      </form>
    </div>
  );
}
