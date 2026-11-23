import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHostAuth, PodFile } from "@panem/core";

/**
 * Git access for pods: Panem gives a pod exactly what its template's repos need, and checks it
 * works before building the pod.
 * - SSH repos: the hosts' keys from the controller's known_hosts (never fetched blindly), aliases
 *   from its ~/.ssh/config, and a short-lived ssh-agent holding only those hosts' keys, forwarded
 *   into the pod's setup session. The pod never gets key files.
 * - HTTPS repos: a token held as a Panem credential, written to a 0600 file that only Panem's git
 *   credential helper reads in the pod. Never in a URL, git config, env or logs.
 */

export type Reason = "url" | "host key" | "credentials" | "access" | "no such ref";

export interface GitProblem {
  repo: string;
  url: string;
  reason: Reason;
  message: string;
}

export interface RepoRemote {
  scheme: "ssh" | "https" | "local";
  /** Host as written in the URL (may be a ~/.ssh/config alias). */
  host: string;
  port?: number;
  user?: string;
}

/** Where a repo URL points. Throws for URLs Panem won't use (plain http, embedded secrets). */
export function parseRepoUrl(url: string): RepoRemote {
  const scp = url.match(/^(?:([^@/:]+)@)?([^:/]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z+]+:\/\//i.test(url)) return { scheme: "ssh", host: scp[2]!, user: scp[1] };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
      return { scheme: "local", host: "" };
    }
    throw new Error(`not a git URL Panem understands: ${redact(url)}`);
  }
  if (u.protocol === "ssh:" || u.protocol === "git+ssh:") {
    return {
      scheme: "ssh",
      host: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      user: u.username || undefined,
    };
  }
  if (u.protocol === "https:") {
    if (u.password || u.username) {
      throw new Error(
        `${redact(url)}: don't put credentials in a repo URL; give the template a "git" token instead`,
      );
    }
    return { scheme: "https", host: u.host };
  }
  if (u.protocol === "file:") return { scheme: "local", host: "" };
  throw new Error(`${redact(url)}: use https:// or SSH (plain ${u.protocol}// isn't supported)`);
}

/** Hide any user:password@ in a URL. */
export function redact(s: string): string {
  return s.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
}

/** Default username for token auth: GitHub wants something; GitLab and others accept oauth2. */
export function defaultTokenUser(host: string): string {
  return host === "github.com" ? "x-access-token" : "oauth2";
}

export interface SshHost {
  /** As written in repo URLs (may be an alias). */
  alias: string;
  hostname: string;
  port: number;
  user?: string;
  /** Existing private key files for this host. */
  keys: string[];
  /** known_hosts lines for the host. */
  knownHosts: string[];
}

export interface HttpsHost {
  host: string;
  username: string;
  token: string;
  /** Credential name, for messages. */
  tokenName: string;
}

export interface RepoAccess {
  name: string;
  url: string;
  ref: string;
  remote: RepoRemote;
}

export interface AccessPlan {
  repos: RepoAccess[];
  ssh: SshHost[];
  https: HttpsHost[];
  problems: GitProblem[];
  /** What the pod gets before setup runs (no private keys, ever). */
  files: PodFile[];
  /** Credential names used as git tokens: never passed into the pod's environment. */
  tokenNames: string[];
}

export interface GitAccessOptions {
  /** ssh client config to read instead of ~/.ssh/config (tests). */
  sshConfig?: string;
  /** Home folder used to expand "~" in IdentityFile (tests); default: the controller user's. */
  home?: string;
  /** known_hosts files to read instead of the ones `ssh -G` names (tests). */
  knownHostsFiles?: string[];
  /** ssh binary for preflight (tests use a fake that serves local repos). */
  sshBin?: string;
  /** Extra `git -c` settings for preflight (tests map https URLs onto a local server). */
  gitConfig?: string[];
  /** Per-repo preflight time limit. */
  timeoutMs?: number;
}

interface Proc {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<Proc & { timedOut: boolean }> {
  const p = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env as Record<string, string>,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, opts.timeoutMs ?? 20_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

/** Parse `ssh -G` output (lower-case keys; repeated keys collect into arrays). */
export function parseSshG(out: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    if (i <= 0) continue;
    const k = line.slice(0, i).toLowerCase();
    m.set(k, [...(m.get(k) ?? []), line.slice(i + 1).trim()]);
  }
  return m;
}

export class GitAccess {
  constructor(private readonly o: GitAccessOptions = {}) {}

  private home(): string {
    return this.o.home ?? homedir();
  }

  private expand(p: string): string {
    return p === "~" ? this.home() : p.replace(/^~\//, `${this.home()}/`);
  }

  /** What `ssh` would use for this host (alias, keys, known_hosts), per the controller's config. */
  async sshHost(alias: string, port?: number, user?: string): Promise<SshHost> {
    const argv = ["ssh", ...(this.o.sshConfig ? ["-F", this.o.sshConfig] : []), "-G"];
    if (port) argv.push("-p", String(port));
    if (user) argv.push("-l", user);
    const r = await run([...argv, alias], { env: process.env });
    if (r.code !== 0) throw new Error(`ssh -G ${alias}: ${r.stderr.trim() || "failed"}`);
    const g = parseSshG(r.stdout);
    const hostname = g.get("hostname")?.[0] ?? alias;
    const realPort = Number(g.get("port")?.[0] ?? 22);
    const keys = (g.get("identityfile") ?? [])
      .flatMap((v) => v.split(/\s+/))
      .filter((v) => v && v !== "none")
      .map((v) => this.expand(v))
      .filter((v) => existsSync(v));
    const files =
      this.o.knownHostsFiles ??
      [...(g.get("userknownhostsfile") ?? []), ...(g.get("globalknownhostsfile") ?? [])]
        .flatMap((v) => v.split(/\s+/))
        .map((v) => this.expand(v));
    const name = realPort === 22 ? hostname : `[${hostname}]:${realPort}`;
    const knownHosts: string[] = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const k = await run(["ssh-keygen", "-F", name, "-f", f], { env: process.env });
      for (const line of k.stdout.split("\n")) {
        if (line && !line.startsWith("#") && !knownHosts.includes(line)) knownHosts.push(line);
      }
    }
    return {
      alias,
      hostname,
      port: realPort,
      user: user ?? g.get("user")?.[0],
      keys,
      knownHosts,
    };
  }

  /** Work out (without contacting any git server) what each repo needs, and what's missing. */
  async plan(
    repos: { name: string; url: string; ref: string }[],
    git: Record<string, GitHostAuth> | undefined,
    credentials: Record<string, string>,
  ): Promise<AccessPlan> {
    const plan: AccessPlan = {
      repos: [],
      ssh: [],
      https: [],
      problems: [],
      files: [],
      tokenNames: [],
    };
    const sshSeen = new Map<string, SshHost>();
    for (const r of repos) {
      let remote: RepoRemote;
      try {
        remote = parseRepoUrl(r.url);
      } catch (e) {
        plan.problems.push({
          repo: r.name,
          url: redact(r.url),
          reason: "url",
          message: String((e as Error).message),
        });
        continue;
      }
      plan.repos.push({ ...r, remote });
      if (remote.scheme === "ssh") {
        const key = `${remote.user ?? ""}@${remote.host}:${remote.port ?? ""}`;
        let h = sshSeen.get(key);
        if (!h) {
          try {
            h = await this.sshHost(remote.host, remote.port, remote.user);
          } catch (e) {
            plan.problems.push({
              repo: r.name,
              url: r.url,
              reason: "url",
              message: String((e as Error).message),
            });
            continue;
          }
          sshSeen.set(key, h);
          plan.ssh.push(h);
        }
        if (h.knownHosts.length === 0) {
          plan.problems.push({
            repo: r.name,
            url: r.url,
            reason: "host key",
            message: `no host key for ${h.hostname} in the controller's known_hosts. Run \`ssh -T ${h.user ? `${h.user}@` : ""}${remote.host}\` on the controller once (as the user Panem runs as) and check the fingerprint against the one ${h.hostname} publishes.`,
          });
        }
        if (h.keys.length === 0) {
          plan.problems.push({
            repo: r.name,
            url: r.url,
            reason: "credentials",
            message: `no SSH key for ${remote.host} on the controller: add an IdentityFile for it in ~/.ssh/config (Panem uses only the keys listed for the template's hosts).`,
          });
        }
      } else if (remote.scheme === "https") {
        const auth = git?.[remote.host];
        if (!auth) continue; // public, or preflight will say otherwise
        if (!plan.tokenNames.includes(auth.token)) plan.tokenNames.push(auth.token);
        const token = credentials[auth.token];
        if (!token) {
          plan.problems.push({
            repo: r.name,
            url: r.url,
            reason: "credentials",
            message: `${auth.token} isn't set: set it in Settings → Agent credentials, or with \`panem env set ${auth.token}\`.`,
          });
          continue;
        }
        if (!plan.https.some((x) => x.host === remote.host)) {
          plan.https.push({
            host: remote.host,
            username: auth.username ?? defaultTokenUser(remote.host),
            token,
            tokenName: auth.token,
          });
        }
      }
    }
    plan.files = podFiles(plan);
    return plan;
  }

  /** Start an ssh-agent holding only this plan's keys (undefined when there are no SSH repos). */
  async agent(plan: AccessPlan): Promise<ScopedAgent | undefined> {
    const keys = [...new Set(plan.ssh.flatMap((h) => h.keys))];
    if (keys.length === 0) return undefined;
    return ScopedAgent.start(keys);
  }

  /**
   * Check each repo is reachable with exactly what the pod will get (`git ls-remote`), so a
   * summon fails before any pod is built. Messages never contain tokens.
   */
  async preflight(plan: AccessPlan, agent: ScopedAgent | undefined): Promise<GitProblem[]> {
    const dir = await mkdtemp(join(tmpdir(), "panem-preflight-"));
    try {
      const kh = join(dir, "known_hosts");
      const cfg = join(dir, "ssh_config");
      await writeFile(kh, `${plan.ssh.flatMap((h) => h.knownHosts).join("\n")}\n`, { mode: 0o600 });
      await writeFile(cfg, sshConfigText(plan.ssh), { mode: 0o600 });
      const sshCmd = [
        this.o.sshBin ?? "ssh",
        "-F",
        cfg,
        "-o",
        `UserKnownHostsFile=${kh}`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentityFile=none",
        "-o",
        "BatchMode=yes",
      ].join(" ");
      const checks = plan.repos
        .filter((r) => r.remote.scheme !== "local")
        .map(async (r): Promise<GitProblem | undefined> => {
          const https = plan.https.find(
            (h) => r.remote.scheme === "https" && h.host === r.remote.host,
          );
          const env: Record<string, string | undefined> = {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
            GIT_SSH_COMMAND: sshCmd,
            SSH_AUTH_SOCK: agent?.sock ?? "",
            PANEM_GIT_USER: https?.username,
            PANEM_GIT_TOKEN: https?.token,
          };
          const helper = https
            ? '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$PANEM_GIT_USER" "$PANEM_GIT_TOKEN"; }; f'
            : "";
          const sha = /^[0-9a-f]{7,40}$/i.test(r.ref);
          const argv = [
            "git",
            "-c",
            "credential.helper=",
            "-c",
            `credential.helper=${helper}`,
            ...(this.o.gitConfig ?? []).flatMap((c) => ["-c", c]),
            "ls-remote",
            "--",
            r.url,
            ...(sha ? [] : [r.ref]),
          ];
          const res = await run(argv, { env, timeoutMs: this.o.timeoutMs ?? 20_000 });
          const scrub = (s: string) => {
            let out = redact(s);
            if (https?.token) out = out.split(https.token).join("***");
            return out;
          };
          if (res.timedOut) {
            return {
              repo: r.name,
              url: r.url,
              reason: "access",
              message: "timed out reaching the git server",
            };
          }
          if (res.code !== 0) {
            const msg = scrub(lastLines(res.stderr));
            return {
              repo: r.name,
              url: r.url,
              reason: classify(res.stderr),
              message: msg || `git exited with ${res.code}`,
            };
          }
          if (!sha && !res.stdout.trim()) {
            return {
              repo: r.name,
              url: r.url,
              reason: "no such ref",
              message: `no branch or tag "${r.ref}"`,
            };
          }
          return undefined;
        });
      return (await Promise.all(checks)).filter((p): p is GitProblem => p !== undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Last meaningful lines of git's stderr. */
function lastLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^fatal: Could not read from remote repository/i.test(l) &&
        !/make sure you have the correct access/i.test(l),
    )
    .slice(-2)
    .join(" ");
}

function classify(stderr: string): Reason {
  if (/host key verification failed|no .* host key is known/i.test(stderr)) return "host key";
  if (
    /permission denied|authentication failed|could not read username|could not read password|access denied|401|403|invalid username or password/i.test(
      stderr,
    )
  ) {
    return "credentials";
  }
  return "access";
}

/** Aliases the pod needs to resolve SSH repo hosts the way the controller does. */
export function sshConfigText(hosts: SshHost[]): string {
  return hosts
    .filter((h) => h.alias !== h.hostname || h.port !== 22 || h.user)
    .map(
      (h) =>
        `Host ${h.alias}\n  HostName ${h.hostname}\n  Port ${h.port}\n${h.user ? `  User ${h.user}\n` : ""}`,
    )
    .join("\n");
}

/** Files the pod gets before setup (see post-create.sh, section 0). */
function podFiles(plan: AccessPlan): PodFile[] {
  const files: PodFile[] = [];
  const kh = plan.ssh.flatMap((h) => h.knownHosts);
  if (kh.length)
    files.push({ path: "~/.panem/git/known_hosts", content: `${kh.join("\n")}\n`, mode: 0o644 });
  const cfg = sshConfigText(plan.ssh);
  if (cfg) files.push({ path: "~/.panem/git/ssh_config", content: cfg, mode: 0o644 });
  if (plan.https.length) {
    files.push({
      path: "~/.panem/git/https-hosts",
      content: `${plan.https.map((h) => `${h.host} ${h.username}`).join("\n")}\n`,
      mode: 0o644,
    });
    files.push({
      path: "~/.config/panem/git-tokens",
      content: `${plan.https.map((h) => `${h.host} ${h.username} ${h.token}`).join("\n")}\n`,
      mode: 0o600,
    });
  }
  return files;
}

/** An ssh-agent of Panem's own, holding only the keys one pod needs, for a limited time. */
export class ScopedAgent {
  private constructor(
    readonly sock: string,
    private readonly dir: string,
    private readonly proc: ReturnType<typeof Bun.spawn>,
  ) {}

  static async start(keys: string[], lifetimeSec = 900): Promise<ScopedAgent> {
    // mkdtemp makes a 0700 folder; the socket path stays short (unix socket length limit).
    const dir = await mkdtemp(join(tmpdir(), "panem-agent-"));
    const sock = join(dir, "s");
    const proc = Bun.spawn(["ssh-agent", "-D", "-a", sock], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const agent = new ScopedAgent(sock, dir, proc);
    for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
    if (!existsSync(sock)) {
      await agent.dispose();
      throw new Error("could not start ssh-agent on the controller (is OpenSSH installed?)");
    }
    for (const key of keys) {
      const r = await run(["ssh-add", "-q", "-t", String(lifetimeSec), key], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          SSH_AUTH_SOCK: sock,
          // No prompt: a key with a passphrase can't be unlocked unattended.
          SSH_ASKPASS: "/bin/false",
          SSH_ASKPASS_REQUIRE: "never",
          DISPLAY: "",
        },
      });
      if (r.code !== 0) {
        await agent.dispose();
        const why = /passphrase|bad permissions|invalid format/i.exec(r.stderr)?.[0] ?? "";
        throw new Error(
          why.toLowerCase() === "passphrase"
            ? `SSH key ${key} has a passphrase: Panem can't unlock it unattended. Use a key without one for git, or a token.`
            : `could not load SSH key ${key}: ${r.stderr.trim()}`,
        );
      }
    }
    return agent;
  }

  /** Fingerprints of the keys held (for tests and logs). */
  async list(): Promise<string> {
    return (
      await run(["ssh-add", "-l"], { env: { PATH: process.env.PATH, SSH_AUTH_SOCK: this.sock } })
    ).stdout;
  }

  async dispose(): Promise<void> {
    this.proc.kill();
    await this.proc.exited.catch(() => {});
    await rm(this.dir, { recursive: true, force: true });
  }
}
