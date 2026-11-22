import { BackendError } from "@panem/core";

export interface RunResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Throw BackendError on non-zero exit (default true). */
  check?: boolean;
  /** Bytes to write to the process's stdin. */
  stdin?: Uint8Array;
}

/** Spawn a CLI without a shell. Arguments are never interpolated into a command string. */
export async function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ?? "ignore",
    env: { ...process.env, ...opts.env },
  });
  const output = Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: Timer | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    if (opts.timeoutMs) timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
  });
  const result = await Promise.race([output, timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    // Grandchildren can hold the pipes open, so don't wait for them after a kill.
    proc.kill("SIGKILL");
    output.catch(() => {});
    throw new BackendError(`${args[0]} timed out after ${opts.timeoutMs}ms`);
  }
  const [stdout, stderr, exitCode] = result;
  if (exitCode !== 0 && opts.check !== false) {
    throw new BackendError(`devpod ${args[0]} failed: ${lastLine(stderr)}`, stderr, exitCode);
  }
  return { exitCode, stdout, stderr };
}

export function lastLine(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "unknown error";
}

export function text(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
