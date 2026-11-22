import { existsSync, statSync } from "node:fs";
import { Mutex } from "./git";

/** The workspace can't be used: none is set yet, or its folder is gone. The API answers 409. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export const NO_WORKSPACE =
  "No workspace yet: run `panem workspace init` in a folder on the controller.";

/**
 * The workspace: a folder on the controller holding templates, panem.json, files to copy into
 * pods and saved agent memory. DevPod builds pods from it (uploading it to the machine).
 * Its path is read fresh on each use, so `panem workspace init` applies without a restart.
 */
export class Workspace {
  /** Serialises writes into the folder (saving memory). */
  readonly lock = new Mutex();

  constructor(private readonly path: () => Promise<string | undefined> | string | undefined) {}

  /** The folder, or undefined when none is set. */
  async current(): Promise<string | undefined> {
    return (await this.path()) || undefined;
  }

  /** The folder; throws WorkspaceError when none is set, or if it's gone. */
  async dir(): Promise<string> {
    const d = await this.current();
    if (!d) throw new WorkspaceError(NO_WORKSPACE);
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      throw new WorkspaceError(
        `workspace folder ${d} is missing: restore it, or run \`panem workspace init\` elsewhere`,
      );
    }
    return d;
  }
}
