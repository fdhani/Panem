import type { Job, Pod } from "@panem/core";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  ExternalLink,
  GitBranch,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
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
            Summon one from a template onto any of your machines. It boots with your repos and
            Claude context ready.
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

type Confirm = "delete" | "force" | null;

function PodCard({ pod, job }: { pod: Pod; job?: Job }) {
  const [confirm, setConfirm] = useState<Confirm>(null);
  const action = useMutation({
    mutationFn: async (a: "stop" | "start" | "delete" | "force" | "retry") => {
      if (a === "delete") return api("DELETE", `/api/pods/${pod.id}`);
      if (a === "force") return api("DELETE", `/api/pods/${pod.id}?force=true`);
      if (a === "retry") return api("POST", `/api/pods/${pod.id}/retry-export`);
      return api("POST", `/api/pods/${pod.id}/${a}`);
    },
    onSettled: () => {
      setConfirm(null);
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

      {pod.exposed.length > 0 && <Services pod={pod} />}

      {pod.error && (
        <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">{pod.error}</p>
      )}
      {action.error && (
        <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">
          {action.error.message}
        </p>
      )}

      {confirm ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-sm">
            {confirm === "delete"
              ? "Export this pod's memory to the workspace repo, then delete it?"
              : "Force delete without exporting? Memory Claude built in this pod will be lost."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate(confirm)}
            >
              {confirm === "delete" ? "Export & delete" : "Discard & delete"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {pod.state === "running" && (
            <>
              <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
                <Button variant="primary" size="sm">
                  <ExternalLink /> Open in Claude
                </Button>
              </a>
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
          {exportFailed && !offline && (
            <Button size="sm" disabled={action.isPending} onClick={() => action.mutate("retry")}>
              <RotateCcw /> Retry export
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {(offline || pod.state === "error") && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm("force")}>
                Force delete
              </Button>
            )}
            {!offline && !exportFailed && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Delete pod"
                disabled={busy}
                onClick={() => setConfirm("delete")}
              >
                <Trash2 /> Delete
              </Button>
            )}
          </div>
        </div>
      )}
      {pod.state === "running" && (
        <p className="text-xs text-muted">
          Remote Control session: <span className="font-mono">{pod.id}</span>
        </p>
      )}
      {offline && (
        <p className="text-xs text-muted">
          Machine is offline. Delete needs it online to export memory.
        </p>
      )}
    </Card>
  );
}

function Services({ pod }: { pod: Pod }) {
  const running = pod.state === "running";
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-xs font-medium text-muted">Services</p>
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
      <ul className="divide-y divide-border">
        {pod.exposed.map((s) => {
          const usable = running && s.live;
          const label = (
            <>
              <span
                className={`size-1.5 shrink-0 rounded-full ${usable ? "bg-ok" : "bg-muted/50"}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{s.name ?? `:${s.podPort}`}</span>
                {s.name && <span className="text-muted"> :{s.podPort}</span>}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted">
                {s.url.replace(/^http:\/\//, "")}
              </span>
            </>
          );
          return (
            <li key={s.hostPort}>
              {usable ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-11 items-center gap-2 px-3 text-sm hover:bg-surface-2"
                >
                  {label}
                  <ArrowUpRight className="size-4 shrink-0 text-muted" />
                </a>
              ) : (
                <div
                  className="flex min-h-11 items-center gap-2 px-3 text-sm opacity-60"
                  title="Not listening right now"
                >
                  {label}
                  <span className="size-4 shrink-0" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
