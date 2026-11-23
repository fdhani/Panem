import { expect, test } from "bun:test";
import type { Pod } from "@panem/core";
import { podIssue } from "../src/lib/pod-issue";

const pod = (p: Partial<Pod>) => ({ state: "running", agents: [], ...p }) as unknown as Pod;
const agent = (id: string, state?: string) =>
  ({ id, label: id, connect: [], status: state ? { state, message: "" } : undefined }) as never;

test("the card says which area has a problem, never which agent or what exactly", () => {
  expect(podIssue(pod({}))).toBeUndefined();
  expect(podIssue(pod({ agents: [agent("claude-code", "running")] }))).toBeUndefined();
  // Stopped at a question in the pod: needs attention, like a missing sign-in.
  expect(podIssue(pod({ agents: [agent("claude-code", "waiting")] }))).toEqual({
    tone: "warn",
    text: "There was an issue with your agent",
  });
  expect(podIssue(pod({ agents: [agent("claude-code", "needs-login")] }))).toEqual({
    tone: "warn",
    text: "There was an issue with your agent",
  });
  expect(
    podIssue(pod({ agents: [agent("claude-code", "needs-login"), agent("codex", "error")] })),
  ).toEqual({ tone: "bad", text: "There was an issue with your agents" });
  expect(
    podIssue(pod({ state: "error", error: "devpod up failed: fatal run agent command" })),
  ).toEqual({
    tone: "bad",
    text: "There was an issue with DevPod",
  });
  expect(
    podIssue(pod({ state: "error", error: "pod setup failed: clone of api failed" }))?.text,
  ).toBe("There was an issue setting up this pod");
  // A pod problem wins over its agents'.
  expect(
    podIssue(
      pod({ state: "error", error: "before-destroy hook failed", agents: [agent("x", "error")] }),
    )?.text,
  ).toBe("There was an issue with this pod");
  // Agents of a stopped pod aren't flagged.
  expect(podIssue(pod({ state: "stopped", agents: [agent("x", "error")] }))).toBeUndefined();
});
