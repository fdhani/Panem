/** Runs commands on a machine: over SSH for remote hosts, directly for "local". */
export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MachineShell {
  run(
    m: { host: string; user?: string },
    argv: string[],
    opts?: { stdin?: string; timeoutMs?: number },
  ): Promise<ShellResult>;
}

/** POSIX single-quote, for the remote shell that ssh hands the command line to. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export class SshShell implements MachineShell {
  async run(
    m: { host: string; user?: string },
    argv: string[],
    opts: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<ShellResult> {
    const cmd =
      m.host === "local"
        ? argv
        : [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "--",
            m.user ? `${m.user}@${m.host}` : m.host,
            argv.map(shq).join(" "),
          ];
    const p = Bun.spawn(cmd, {
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  }
}
