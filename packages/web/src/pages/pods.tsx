import type { Job, Pod } from "@panem/core";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ExternalLink, GitBranch, Play, Plus, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { type DeleteChoice, DeleteDialog } from "../components/delete-dialog";
import { MachineDot, PodStateBadge } from "../components/status";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { api, keys, queryClient, useJobs, usePods } from "../lib/api";
import { timeAgo } from "../lib/utils";
import { QueryError } from "./shared";

export function PodsPage() {
  const pods = usePods();
  const jobs = useJobs();
  if (pods.error) return <QueryError error={pods.error} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Pods</h1>
        <Link to="/summon">
          <Button variant="primary" size="sm">
            <Plus /> Summon
          </Button>
        </Link>
      </div>
      {pods.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {pods.data?.length === 0 && (
        <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="font-medium">No pods yet</p>
          <p className="max-w-xs text-sm text-muted">
            Summon one from a template onto any of your machines. It boots with your repos and your
            agent's context ready.
          </p>
          <Link to="/summon">
            <Button variant="primary">
              <Plus /> Summon a pod
            </Button>
          </Link>
        </Card>
      )}
      <ul className="flex flex-col gap-3">
        {pods.data?.map((p) => (
          <li key={p.id}>
            <PodCard
              pod={p}
              job={jobs.data?.find((j) => j.podId === p.id && j.status !== "done")}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PodCard({ pod, job }: { pod: Pod; job?: Job }) {
  const [deleting, setDeleting] = useState(false);
  const action = useMutation({
    mutationFn: async (a: "stop" | "start" | DeleteChoice) => {
      if (a === "save") return api("DELETE", `/api/pods/${pod.id}`);
      if (a === "nomemory") return api("DELETE", `/api/pods/${pod.id}?memory=false`);
      if (a === "force") return api("DELETE", `/api/pods/${pod.id}?force=true`);
      if (a === "retry") return api("POST", `/api/pods/${pod.id}/retry-export`);
      return api("POST", `/api/pods/${pod.id}/${a}`);
    },
    onSettled: () => {
      setDeleting(false);
      queryClient.invalidateQueries({ queryKey: keys.pods });
    },
  });
  const offline = pod.machineStatus === "offline";
  const busy = ["creating", "starting", "stopping", "exporting", "deleting"].includes(pod.state);
  const exportFailed = job?.status === "failed";

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[15px] font-medium">{pod.id}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span>{pod.template}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              <MachineDot status={pod.machineStatus} />
              {pod.machine.replace(/^m-/, "")}
            </span>
            {pod.createdAt && (
              <>
                <span aria-hidden>·</span>
                <span>{timeAgo(pod.createdAt)}</span>
              </>
            )}
          </p>
        </div>
        <PodStateBadge state={pod.state} />
      </div>

      {pod.repos.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {pod.repos.map((r) => (
            <li
              key={r.name}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-2 py-1 font-mono text-xs"
            >
              <GitBranch className="size-3 shrink-0 text-muted" />
              <span className="truncate">
                {r.name}
                <span className="text-muted">@{r.ref}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {(pod.state === "running" || pod.services.length > 0) && <Services pod={pod} />}

      {pod.error && (
        <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">{pod.error}</p>
      )}
      {action.error && (
        <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">
          {action.error.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {pod.state === "running" && (
          <>
            {(pod.agents ?? []).flatMap((a) =>
              a.connect.map((c) => (
                <a key={`${a.id}:${c.url}`} href={c.url} target="_blank" rel="noreferrer">
                  <Button variant="primary" size="sm" title={a.label || a.id}>
                    <ExternalLink /> {c.label}
                  </Button>
                </a>
              )),
            )}
            <Button
              size="sm"
              disabled={offline || action.isPending}
              onClick={() => action.mutate("stop")}
            >
              <Square /> Stop
            </Button>
          </>
        )}
        {pod.state === "stopped" && (
          <Button
            size="sm"
            disabled={offline || action.isPending}
            onClick={() => action.mutate("start")}
          >
            <Play /> Start
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Delete pod"
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => setDeleting(true)}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>
      <DeleteDialog
        pod={pod}
        open={deleting}
        onClose={() => setDeleting(false)}
        onChoose={(c) => action.mutate(c)}
        busy={action.isPending}
        saveFailed={exportFailed}
      />
      {pod.state === "running" && (pod.agents ?? []).length > 0 && (
        <p className="text-xs text-muted">
          {(pod.agents ?? []).map((a) => a.label || a.id).join(", ")} · session{" "}
          <span className="font-mono">{pod.id}</span>
        </p>
      )}
      {offline && (
        <p className="text-xs text-muted">
          Machine is offline. Deleting now skips its before-destroy hooks and memory.
        </p>
      )}
    </Card>
  );
}

function Services({ pod }: { pod: Pod }) {
  const running = pod.state === "running";
  const [adding, setAdding] = useState("");
  const toggle = useMutation({
    mutationFn: ({ port, exposed }: { port: number; exposed: boolean }) =>
      api("PUT", `/api/pods/${pod.id}/ports/${port}`, { exposed }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.pods }),
  });
  const addPort = Number(adding);
  const canAdd = Number.isInteger(addPort) && addPort > 0 && addPort < 65536 && !toggle.isPending;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-xs font-medium text-muted">Ports</p>
        {pod.indexUrl && running && (
          <a
            href={pod.indexUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted underline-offset-2 hover:text-text hover:underline"
          >
            All links
          </a>
        )}
      </div>
      {pod.services.length === 0 && (
        <p className="px-3 py-2.5 text-xs text-muted">
          Nothing listening yet. Ports show up here when something starts listening.
        </p>
      )}
      <ul className="divide-y divide-border">
        {pod.services.map((s) => {
          const linked = running && s.exposed && s.url;
          return (
            <li key={s.podPort} className="flex min-h-12 items-center gap-2 px-3 text-sm">
              <span
                className={`size-1.5 shrink-0 rounded-full ${s.live && running ? "bg-ok" : "bg-muted/50"}`}
                title={s.live ? "Listening" : "Not listening"}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{s.name ?? `:${s.podPort}`}</span>
                {s.name && <span className="text-muted"> :{s.podPort}</span>}
                {linked ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 inline-flex items-center gap-0.5 font-mono text-xs text-accent hover:underline"
                  >
                    {s.url!.replace(/^http:\/\//, "")}
                    <ArrowUpRight className="size-3" />
                  </a>
                ) : s.exposed ? (
                  <span className="ml-2 text-xs text-muted">{running ? "publishing…" : "on"}</span>
                ) : null}
              </span>
              <Switch
                checked={s.exposed}
                disabled={toggle.isPending}
                label={`Expose ${s.name ?? `port ${s.podPort}`}`}
                onChange={(exposed) => toggle.mutate({ port: s.podPort, exposed })}
              />
            </li>
          );
        })}
      </ul>
      <form
        className="flex items-center gap-2 border-t border-border px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          toggle.mutate({ port: addPort, exposed: true }, { onSuccess: () => setAdding("") });
        }}
      >
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="Port to expose"
          placeholder="Expose another port…"
          value={adding}
          onChange={(e) => setAdding(e.target.value.replace(/\D/g, "").slice(0, 5))}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-base sm:text-sm"
        />
        <Button type="submit" size="sm" disabled={!canAdd}>
          Expose
        </Button>
      </form>
      {toggle.error && (
        <p className="border-t border-border px-3 py-2 text-xs break-words text-bad">
          {toggle.error.message}
        </p>
      )}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${checked ? "bg-accent" : "bg-border"}`}
    >
      <span
        className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}
