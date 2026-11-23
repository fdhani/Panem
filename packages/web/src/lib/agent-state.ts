/** How an agent's reported state is shown (from agent_status in the pod). */
export const AGENT_STATE: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> =
  {
    running: { label: "Running", tone: "ok" },
    "needs-login": { label: "Needs sign-in", tone: "warn" },
    error: { label: "Error", tone: "bad" },
    stopped: { label: "Off", tone: "muted" },
  };
