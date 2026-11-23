import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft, RefreshCw, RotateCcw } from "lucide-react";
import { SignInButton } from "../components/sign-in";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { machineLabel } from "../lib/agent-login";
import { AGENT_STATE } from "../lib/agent-state";
import { api, apiText, keys, queryClient, usePods } from "../lib/api";
import { timeAgo } from "../lib/utils";
import { QueryError } from "./shared";

/** One agent in a pod: its state, what to do next, and its own log as it wrote it. */
export function AgentPage() {
  const { id, agent } = useParams({ from: "/pods/$id/agents/$agent" });
  const pods = usePods();
  const pod = pods.data?.find((p) => p.id === id);
  const a = pod?.agents?.find((x) => x.id === agent);
  const log = useQuery({
    queryKey: ["agent-log", id, agent],
    queryFn: async () =>
      (await apiText(
        `/api/pods/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}/log`,
      )) ?? "",
    enabled: !!a?.log && pod?.state === "running",
  });
  const restart = useMutation({
    mutationFn: () => api("POST", `/api/pods/${id}/agents/${agent}/restart`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: keys.pods });
      log.refetch();
    },
  });

  const back = (
    <Link
      to="/pods/$id"
      params={{ id }}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"
    >
      <ChevronLeft className="size-4" /> {id}
    </Link>
  );
  if (pods.error) return <QueryError error={pods.error} />;
  if (!pods.data) return <p className="text-sm text-muted">Loading…</p>;
  if (!pod || !a) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="text-sm text-muted">This agent isn't in pod {id} any more.</p>
      </div>
    );
  }
  const st = a.status ? AGENT_STATE[a.status.state] : undefined;
  const where = machineLabel(pod.machine);

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{a.label || a.id}</h1>
          <p className="text-sm text-muted">
            <span className="font-mono">{a.id}</span> in <span className="font-mono">{pod.id}</span>
            {a.status?.at && <> · {timeAgo(a.status.at)}</>}
          </p>
        </div>
        {st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>Unknown</Badge>}
      </div>

      {a.status?.message && <p className="text-sm break-words">{a.status.message}</p>}

      {a.status?.state === "needs-login" && a.login && (
        <Card className="flex flex-col gap-2 p-4 text-sm">
          <h2 className="font-medium">{a.login.label}</h2>
          {a.login.shared === false ? (
            <>
              <p className="break-words text-warn">
                This pod can't use {where}'s sign-in: {a.login.reason ?? "unknown reason"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <SignInButton
                  scope={{ machine: pod.machine, agent: a.id, label: a.login.label, pod: pod.id }}
                >
                  Sign in this pod only
                </SignInButton>
              </div>
            </>
          ) : (
            <>
              <p className="text-muted">One sign-in serves every pod on {where}.</p>
              <div className="flex flex-wrap items-center gap-2">
                <SignInButton scope={{ machine: pod.machine, agent: a.id, label: a.login.label }}>
                  Sign in on {where}
                </SignInButton>
              </div>
            </>
          )}
          <p className="text-xs text-muted">
            Or on the controller:{" "}
            <code className="font-mono break-all">
              panem {a.login.shared === false ? `pod login ${pod.id}` : `machine login ${where}`}{" "}
              {a.id}
            </code>
          </p>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={restart.isPending || pod.state !== "running"}
          onClick={() => restart.mutate()}
        >
          <RotateCcw /> {restart.isPending ? "Restarting…" : "Restart agent"}
        </Button>
        {a.log && (
          <Button size="sm" variant="ghost" disabled={log.isFetching} onClick={() => log.refetch()}>
            <RefreshCw /> Refresh log
          </Button>
        )}
      </div>

      {a.log ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">
            Log <span className="font-mono text-xs font-normal text-muted">{a.log}</span>
          </h2>
          {log.error ? (
            <p className="text-sm text-bad">{(log.error as Error).message}</p>
          ) : (
            <pre className="max-h-[70vh] min-h-24 overflow-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap">
              {log.isLoading ? "Loading…" : log.data || "(empty)"}
            </pre>
          )}
        </section>
      ) : (
        <p className="text-sm text-muted">This agent keeps no log.</p>
      )}
    </div>
  );
}
