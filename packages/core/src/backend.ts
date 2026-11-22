/** What a backend reports about a workspace, independent of controller metadata. */
export interface BackendPod {
  id: string;
  machine: string;
  status: "running" | "stopped" | "busy" | "notfound" | "unknown";
}

export interface BackendMachine {
  name: string;
  host: string;
  user?: string;
}

export interface UpOptions {
  id: string;
  machine: string;
  /** Git URL (or local path) of the source the pod is built from. */
  source: string;
  /** Branch of the source. */
  sourceRef?: string;
  devcontainerPath: string;
  env: Record<string, string>;
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
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  exec(id: string, command: string): Promise<ExecResult>;
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
  constructor(
    message: string,
    readonly stderr = "",
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
