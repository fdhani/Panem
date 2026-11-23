import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react";
import { PodResourcesCard } from "../components/resources";
import { MachineDot, PodStateBadge } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { AGENT_STATE } from "../lib/agent-state";
import { apiText, usePods } from "../lib/api";
import { timeAgo } from "../lib/utils";
import { Services } from "./pods";
import { QueryError } from "./shared";

/** One pod in full: what's wrong and what to do, its agents, repos and ports. */
export function PodPage() {
  const { id } = useParams({ from: "/pods/$id" });
  const pods = usePods();
  const pod = pods.data?.find((p) => p.id === id);
  const log = useQuery({
    queryKey: ["pod-log", id],
    queryFn: async () => (await apiText(`/api/pods/${encodeURIComponent(id)}/log`)) ?? "",
    enabled: false,
  });

  if (pods.error) return <QueryError error={pods.error} />;
  if (!pods.data) return <p className="text-sm text-muted">Loading…</p>;
  if (!pod) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p className="text-sm text-muted">Pod {id} isn't here any more.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-mono text-lg font-semibold">{pod.id}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span>{pod.template}</span>
            <span aria-hidden>·</span>
            <Link
              to="/machines/$name"
              params={{ name: pod.machine }}
              className="inline-flex items-center gap-1.5 hover:text-text hover:underline"
            >
              <MachineDot status={pod.machineStatus} />
              {pod.machine.replace(/^m-/, "")}
            </Link>
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

      {pod.error && (
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="font-medium text-bad">Error</h2>
          <p className="text-sm break-words text-bad">{pod.error}</p>
          {pod.errorLog?.length ? (
            <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre">
              {pod.errorLog.join("\n")}
            </pre>
          ) : null}
          <div>
            <Button size="sm" disabled={log.isFetching} onClick={() => log.refetch()}>
              {log.isFetching ? "Loading…" : "Show the full log"}
            </Button>
          </div>
          {log.data !== undefined &&
            (log.data ? (
              <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre">
                {log.data}
              </pre>
            ) : (
              <p className="text-xs text-muted">No saved output for this pod.</p>
            ))}
        </Card>
      )}

      {pod.state === "running" && (pod.agents ?? []).length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Agents</h2>
          {(pod.agents ?? []).map((a) => {
            const st = a.status ? AGENT_STATE[a.status.state] : undefined;
            return (
              <Link
                key={a.id}
                to="/pods/$id/agents/$agent"
                params={{ id: pod.id, agent: a.id }}
                className="block"
              >
                <Card className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{a.label || a.id}</span>
                  {st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>Unknown</Badge>}
                  <ChevronRight className="size-4 shrink-0 text-muted" />
                </Card>
              </Link>
            );
          })}
        </section>
      )}

      <PodResourcesCard pod={pod} />

      {pod.repos.length > 0 && (
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="font-medium">Repos</h2>
          <ul className="flex flex-col gap-1.5">
            {pod.repos.map((r) => (
              <li key={r.name} className="flex min-w-0 items-center gap-2 font-mono text-xs">
                <GitBranch className="size-3 shrink-0 text-muted" />
                <span className="truncate">
                  {r.name}
                  <span className="text-muted">@{r.ref}</span>
                </span>
                <span className="truncate text-muted">{r.url}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(pod.state === "running" || pod.services.length > 0) && <Services pod={pod} />}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ChevronLeft className="size-4" /> Pods
    </Link>
  );
}
