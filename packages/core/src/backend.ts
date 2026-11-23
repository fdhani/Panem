/** What a backend reports about a workspace, independent of controller metadata. */
export interface BackendPod {
  id: string;
  machine: string;
  status: "running" | "stopped" | "busy" | "notfound" | "unknown";
  /**
   * The backend's own id for the pod's container, when it has one (DevPod: the workspace UID,
   * which labels the container dev.containers.id=<uid>). Used to find its resource usage.
   */
  uid?: string;
}

export interface BackendMachine {
  name: string;
  host: string;
  user?: string;
}

/**
 * Runs `fn` while the pod's source folder is held: nothing else writes to it, and no other
 * build reads it, until `fn` settles. DevPod builds straight from the folder on the local
 * machine, so a write (or another build) mid-build can break it.
 */
export type FolderLock = <T>(fn: () => Promise<T>) => Promise<T>;

export interface UpOptions {
  id: string;
  machine: string;
  /** Git URL (or local path) of the source the pod is built from. */
  source: string;
  /** Branch of the source. */
  sourceRef?: string;
  devcontainerPath: string;
  env: Record<string, string>;
  /**
   * Files to place in the pod before its one-time setup runs (e.g. git host keys and the git
   * token file). Paths start with "~/" (the pod user's home). Sent over stdin, never argv/env.
   */
  files?: PodFile[];
  /** An ssh-agent socket on the controller to forward into the setup session (git over SSH). */
  sshAuthSock?: string;
  /** Held while DevPod reads the source folder (the build), not during setup. */
  withFolder?: FolderLock;
}

export interface PodFile {
  /** "~/..." in the pod. */
  path: string;
  content: string;
  /** Octal mode, e.g. 0o600. */
  mode: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

/**
 * The only seam between the controller and the pod runtime.
 * DevPod implements it today; the devcontainer CLI can implement it later.
 */
export interface PodBackend {
  up(opts: UpOptions): Promise<void>;
  list(): Promise<BackendPod[]>;
  start(id: string, opts?: { withFolder?: FolderLock }): Promise<void>;
  /**
   * argv that runs `command` in the pod interactively, for a terminal (PTY) on the controller:
   * an agent's sign-in. Its env must not lend the controller's ssh-agent.
   */
  interactiveArgv(id: string, command: string): { argv: string[]; env: Record<string, string> };
  stop(id: string): Promise<void>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  exec(id: string, command: string, opts?: { sshAuthSock?: string }): Promise<ExecResult>;
  /** The saved output of the pod's last `up` (and failed setup), if the backend keeps it. */
  log?(id: string): Promise<string | undefined>;
  /** Run `command` in the pod with `data` on its stdin (e.g. a tar to unpack). */
  upload(id: string, data: Uint8Array, command: string): Promise<ExecResult>;
  /**
   * Run a pod lifecycle hook. `up` runs only the one-time setup, so the controller can place
   * synced files before "start" launches the agent; `start()` runs "start" itself.
   */
  runHook(id: string, hook: "start"): Promise<void>;

  addMachine(m: BackendMachine): Promise<void>;
  removeMachine(name: string): Promise<void>;
  listMachines(): Promise<BackendMachine[]>;
}

export class BackendError extends Error {
  /** The last lines of the command's output (escape codes stripped), for diagnosing it. */
  detail?: string[];
  constructor(
    message: string,
    readonly stderr = "",
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
