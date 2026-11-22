import type { Pod } from "@panem/core";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type DeleteChoice = "save" | "nomemory" | "force" | "retry";

/** Whether deleting this pod can save agent memory. */
export function hasMemory(pod: Pod): boolean {
  // Pods from before sync rules have no snapshot: they're on the defaults, which keep memory.
  return pod.sync ? pod.sync.rules.some((r) => r.memory) : true;
}

/**
 * Before-destroy hooks run on every delete, so the only choice is memory. Force delete (skips
 * hooks too) is offered only when hooks can't run: the machine is offline, or the last attempt
 * failed.
 */
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
  /** The last attempt (hooks or memory save) failed. */
  saveFailed: boolean;
}) {
  const offline = pod.machineStatus === "offline";
  const memory = hasMemory(pod);

  let text: string;
  let buttons: { label: string; choice: DeleteChoice; variant: "primary" | "danger" }[];
  let note: string | undefined;
  if (offline) {
    text = "Its machine is offline, so before-destroy hooks can't run and memory can't be saved.";
    buttons = [{ label: "Force delete", choice: "force", variant: "danger" }];
  } else if (saveFailed) {
    text = "The last attempt failed. Retry runs the before-destroy hooks again.";
    buttons = [
      { label: "Retry", choice: "retry", variant: "primary" },
      { label: "Force delete", choice: "force", variant: "danger" },
    ];
  } else if (memory) {
    text =
      "Any before-destroy hooks run first. The agent's memory can be saved to the workspace repo.";
    buttons = [
      { label: "Save memory & delete", choice: "save", variant: "primary" },
      { label: "Delete without saving memory", choice: "nomemory", variant: "danger" },
    ];
    note = '"Delete without saving memory": memory the agent built in this pod will be lost.';
  } else {
    text = "Any before-destroy hooks run first. Everything else in the pod is removed with it.";
    buttons = [{ label: "Delete", choice: "save", variant: "danger" }];
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Delete ${pod.id}?`}>
      <div className="flex flex-col gap-4">
        {saveFailed && pod.error && (
          <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">{pod.error}</p>
        )}
        <p className="text-sm text-muted">{text}</p>
        <div className="flex flex-col gap-2">
          {buttons.map((b) => (
            <Button
              key={b.choice}
              variant={b.variant}
              disabled={busy}
              onClick={() => onChoose(b.choice)}
            >
              {b.label}
            </Button>
          ))}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
    </Dialog>
  );
}
