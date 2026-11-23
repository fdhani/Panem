import type {
  CredentialInfo,
  Job,
  Machine,
  Pod,
  ServerEvent,
  SummonRequest,
  Template,
} from "@panem/core";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const TOKEN_KEY = "panem.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // private mode: token lives only for this page load
  }
  memoryToken = t;
  window.dispatchEvent(new Event("panem-token"));
}

let memoryToken = "";
const token = () => getToken() || memoryToken;
/** Whether a token is entered (saved, or for this page load in private mode). */
export const hasToken = () => !!token();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
      staleTime: 10_000,
    },
  },
});

export const keys = {
  pods: ["pods"] as const,
  machines: ["machines"] as const,
  jobs: ["jobs"] as const,
  templates: ["templates"] as const,
  credentials: ["credentials"] as const,
  workspace: ["workspace"] as const,
};

export interface GitCheck {
  checked: boolean;
  problems: { repo: string; url: string; reason: string; message: string }[];
}

/** Whether a template's repos are reachable with what its pods will get (cached server-side). */
export const useGitCheck = (template: string) =>
  useQuery({
    queryKey: ["git-check", template],
    queryFn: () => api<GitCheck>("GET", `/api/templates/${encodeURIComponent(template)}/git-check`),
    enabled: !!template,
    staleTime: 60_000,
    retry: false,
  });

/** The controller's workspace folder (undefined until `panem workspace init`). */
export const useWorkspace = () =>
  useQuery({
    queryKey: keys.workspace,
    queryFn: () => api<{ dir?: string }>("GET", "/api/workspace"),
  });

export const useCredentials = () =>
  useQuery({
    queryKey: keys.credentials,
    queryFn: () => api<CredentialInfo[]>("GET", "/api/credentials"),
  });

export const usePods = () =>
  useQuery({ queryKey: keys.pods, queryFn: () => api<Pod[]>("GET", "/api/pods") });
export const useMachines = () =>
  useQuery({ queryKey: keys.machines, queryFn: () => api<Machine[]>("GET", "/api/machines") });
export const useJobs = () =>
  useQuery({
    queryKey: keys.jobs,
    queryFn: async () => (await api<{ jobs: Job[] }>("GET", "/api/jobs")).jobs,
  });
export const useTemplates = () =>
  useQuery({
    queryKey: keys.templates,
    queryFn: () =>
      api<{
        templates: Template[];
        errors: { name: string; error: string }[];
        warnings?: { name: string; warning: string }[];
      }>("GET", "/api/templates"),
  });

export const summon = (req: SummonRequest) => api<Pod>("POST", "/api/pods", req);

export type LiveStatus = "connecting" | "live" | "offline";

/** Live updates over SSE; writes straight into the query cache. Reconnects with backoff. */
export function useLiveEvents(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [tok, setTok] = useState(token());
  useEffect(() => {
    const onTok = () => setTok(token());
    window.addEventListener("panem-token", onTok);
    return () => window.removeEventListener("panem-token", onTok);
  }, []);
  useEffect(() => {
    if (!tok) {
      setStatus("offline");
      return;
    }
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let closed = false;
    const connect = () => {
      setStatus("connecting");
      es = new EventSource(`/api/events?token=${encodeURIComponent(tok)}`);
      es.onopen = () => {
        delay = 1000;
        setStatus("live");
      };
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as ServerEvent;
        if (e.type === "pods") queryClient.setQueryData(keys.pods, e.pods);
        if (e.type === "machines") queryClient.setQueryData(keys.machines, e.machines);
        if (e.type === "jobs") queryClient.setQueryData(keys.jobs, e.jobs);
      };
      es.onerror = () => {
        es?.close();
        setStatus("offline");
        delay = Math.min(delay * 2, 30_000);
        if (!closed) retry = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [tok]);
  return status;
}
