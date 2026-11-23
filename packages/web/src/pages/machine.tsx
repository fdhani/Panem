import type { ForwarderStatus } from "@panem/core";
import { useMutation } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { MachineAgents } from "../components/agent-logins";
import { MachineDot, PodStateBadge } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { machineLabel } from "../lib/agent-login";
import { api, keys, queryClient, useMachines, usePods } from "../lib/api";
import { QueryError } from "./shared";

/** One machine: its status and port forwarding, its agents and their sign-ins, its pods. */
export function MachinePage() {
  const { name } = useParams({ from: "/machines/$name" });
  const machines = useMachines();
  const pods = usePods();
  const m = machines.data?.find((x) => x.name === name);
  const repair = useMutation({
    mutationFn: () => api("POST", `/api/machines/${encodeURIComponent(name)}/repair`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.machines }),
  });

  const back = (
    <Link
      to="/machines"
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"
    >
      <ChevronLeft className="size-4" /> Machines
    </Link>
  );
  if (machines.error) return <QueryError error={machines.error} />;
  if (!machines.data) return <p className="text-sm text-muted">Loading…</p>;
  if (!m) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="text-sm text-muted">Machine {machineLabel(name)} isn't registered.</p>
      </div>
    );
  }
  const here = (pods.data ?? []).filter((p) => p.machine === m.name);
  const fwd = m.forwarder;

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <MachineDot status={m.status} /> {machineLabel(m.name)}
        </h1>
        <p className="mt-0.5 font-mono text-xs text-muted">
          {m.user ? `${m.user}@` : ""}
          {m.host} · {m.status} · {here.length} pod{here.length === 1 ? "" : "s"}
        </p>
        {fwd && fwd.status !== "disabled" && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ForwarderBadge f={fwd} />
            {fwd.status !== "running" && m.status !== "offline" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={repair.isPending}
                onClick={() => repair.mutate()}
              >
                <RefreshCw className={repair.isPending ? "animate-spin" : ""} /> Repair
              </Button>
            )}
          </div>
        )}
        {fwd?.error && fwd.status !== "running" && (
          <p className="mt-1 text-xs break-words text-bad">{fwd.error}</p>
        )}
        {repair.error && <p className="mt-1 text-xs text-bad">{repair.error.message}</p>}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Agents</h2>
        <MachineAgents machine={m} pods={pods.data ?? []} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Pods</h2>
        {here.length === 0 ? (
          <p className="text-sm text-muted">
            No pods here.{" "}
            <Link to="/summon" className="text-accent underline-offset-2 hover:underline">
              Summon one
            </Link>
          </p>
        ) : (
          <Card className="divide-y divide-border">
            {here.map((p) => (
              <Link
                key={p.id}
                to="/pods/$id"
                params={{ id: p.id }}
                className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm">{p.id}</span>
                  <span className="block truncate text-xs text-muted">{p.template}</span>
                </span>
                <PodStateBadge state={p.state} />
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </Link>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

export function ForwarderBadge({ f }: { f: ForwarderStatus }) {
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
