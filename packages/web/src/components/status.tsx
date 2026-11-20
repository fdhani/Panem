import type { MachineStatus, PodState } from "@panem/core";
import { Badge } from "./ui/badge";

const podTone: Record<PodState, "ok" | "warn" | "bad" | "info" | "muted"> = {
  running: "ok",
  stopped: "muted",
  creating: "info",
  starting: "info",
  stopping: "warn",
  exporting: "info",
  deleting: "warn",
  error: "bad",
};

const busy = new Set<PodState>(["creating", "starting", "stopping", "exporting", "deleting"]);

export function PodStateBadge({ state }: { state: PodState }) {
  return (
    <Badge tone={podTone[state]}>
      <span
        className={`size-1.5 rounded-full bg-current ${busy.has(state) ? "animate-pulse" : ""}`}
      />
      {state}
    </Badge>
  );
}

export function MachineDot({ status }: { status: MachineStatus }) {
  const color = status === "online" ? "bg-ok" : status === "offline" ? "bg-bad" : "bg-muted";
  return (
    <span
      role="img"
      aria-label={status}
      title={status}
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
    />
  );
}
