import type { Pod } from "@panem/core";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type DeleteChoice = "save" | "discard" | "retry";

/** What deleting this pod would save first: agent memory and/or a template hook. */
export function whatWouldSave(pod: Pod): { memory: boolean; hook: boolean } {
  // Pods from before sync rules have no snapshot: they're on the defaults, which keep memory.
  const memory = pod.sync ? pod.sync.rules.some((r) => r.memory) : true;
  return { memory, hook: Boolean(pod.hooks?.beforeDestroy) };
}

export function DeleteDialog({
  pod,
  open,
  onClose,
  onChoose,
  busy,
  saveFailed,
}: {
  pod: Pod;
  open: boolean;
  onClose: () => void;
  onChoose: (c: DeleteChoice) => void;
  busy: boolean;
  /** The last save (hooks or memory) failed; offer to retry it. */
  saveFailed: boolean;
}) {
  const offline = pod.machineStatus === "offline";
  const { memory, hook } = whatWouldSave(pod);
  const saves = memory || hook;
  const steps = [
    hook && "runs the template's before-destroy hook",
    memory && "saves the agent's memory to the workspace repo",
  ].filter(Boolean);
  const lost = memory
    ? "Memory the agent built in this pod will be lost."
    : "The before-destroy hook won't run.";

  return (
    <Dialog open={open} onClose={onClose} title={`Delete ${pod.id}?`}>
      <div className="flex flex-col gap-4">
        {saveFailed && pod.error && (
          <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">{pod.error}</p>
        )}
        {offline ? (
          <p className="text-sm text-muted">
            Its machine is offline, so nothing can be saved first.{saves ? ` ${lost}` : ""}
          </p>
        ) : saves ? (
          <p className="text-sm text-muted">
            Deleting first {steps.join(", then ")}. Synced files and anything else in the pod are
            removed with it.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Nothing in this pod is saved back; it's removed with everything in it.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {!offline && saves && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => onChoose(saveFailed ? "retry" : "save")}
            >
              {saveFailed
                ? "Retry save & delete"
                : memory
                  ? "Save memory & delete"
                  : "Run hook & delete"}
            </Button>
          )}
          <Button variant="danger" disabled={busy} onClick={() => onChoose("discard")}>
            {saves ? "Delete without saving" : "Delete"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {saves && !offline && <p className="text-xs text-muted">"Delete without saving": {lost}</p>}
      </div>
    </Dialog>
  );
}
