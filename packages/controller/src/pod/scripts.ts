import { shq } from "../shell";
// The in-pod scripts, embedded as text (also in the compiled binary).
import APPLY_SYNC from "./apply-sync.sh" with { type: "text" };
import BEFORE_DESTROY from "./before-destroy.sh" with { type: "text" };
import EXPORT from "./export.sh" with { type: "text" };

/** Shell command that runs an embedded script with arguments, via bash. */
export function bashCommand(script: string, name: string, args: (string | number)[] = []): string {
  return ["bash", "-c", script, name, ...args.map(String)].map(shq).join(" ");
}

export const APPLY_SYNC_SCRIPT = APPLY_SYNC;
export const EXPORT_SCRIPT = EXPORT;
export const BEFORE_DESTROY_SCRIPT = BEFORE_DESTROY;
