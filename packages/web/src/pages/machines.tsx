import type { ForwarderStatus } from "@panem/core";
import { useMutation } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { MachineDot } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, Input } from "../components/ui/field";
import { api, keys, queryClient, useMachines, usePods } from "../lib/api";
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
  const repair = useMutation({
    mutationFn: (name: string) => api("POST", `/api/machines/${name}/repair`),
    onSettled: refresh,
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
          return (
            <div key={m.name} className="flex items-center gap-3 p-4">
              <MachineDot status={m.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{m.name.replace(/^m-/, "")}</p>
                <p className="truncate font-mono text-xs text-muted">
                  {m.user ? `${m.user}@` : ""}
                  {m.host} · {m.status} · {count} pod{count === 1 ? "" : "s"}
                </p>
                {m.forwarder && m.forwarder.status !== "disabled" && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <ForwarderBadge f={m.forwarder} />
                    {m.forwarder.status !== "running" && m.status !== "offline" && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs text-accent disabled:opacity-50"
                        disabled={repair.isPending}
                        onClick={() => repair.mutate(m.name)}
                      >
                        <RefreshCw className={`size-3 ${repair.isPending ? "animate-spin" : ""}`} />
                        Repair
                      </button>
                    )}
                  </div>
                )}
                {m.forwarder?.error && m.forwarder.status !== "running" && (
                  <p className="mt-1 text-xs break-words text-bad">{m.forwarder.error}</p>
                )}
              </div>
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
      {repair.error && <p className="text-sm text-bad">{repair.error.message}</p>}

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

function ForwarderBadge({ f }: { f: ForwarderStatus }) {
  const tone = f.status === "running" ? "ok" : f.status === "outdated" ? "warn" : "bad";
  const text =
    f.status === "running"
      ? "ports exposed"
      : f.status === "outdated"
        ? "forwarder outdated"
        : f.status === "missing"
          ? "forwarder not responding"
          : "forwarder error";
  return <Badge tone={tone}>{text}</Badge>;
}
