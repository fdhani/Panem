import type { Pod } from "@panem/core";

/**
 * One general line for the card when something needs attention; the pod's page has the details.
 * Names the area (DevPod, the pod's setup, the agents), never a specific agent or message.
 */
export function podIssue(pod: Pod): { tone: "warn" | "bad"; text: string } | undefined {
  if (pod.error) {
    const e = pod.error;
    if (/^devpod\b/i.test(e)) return { tone: "bad", text: "There was an issue with DevPod" };
    if (/^pod (setup|start hook) failed/i.test(e)) {
      return { tone: "bad", text: "There was an issue setting up this pod" };
    }
    return { tone: "bad", text: "There was an issue with this pod" };
  }
  if (pod.state !== "running") return undefined;
  const troubled = (pod.agents ?? []).filter(
    (a) => a.status?.state === "needs-login" || a.status?.state === "error",
  );
  if (!troubled.length) return undefined;
  return {
    tone: troubled.some((a) => a.status?.state === "error") ? "bad" : "warn",
    text: `There was an issue with your ${troubled.length > 1 ? "agents" : "agent"}`,
  };
}

/** A short line on the card when something needs attention, linking to the pod's page. */
