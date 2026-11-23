import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAccess } from "../src/git-access";

const G = "git -c user.email=t@t -c user.name=t";
const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr}`);
  return p.stdout.toString();
};

/**
 * A controller home with an ssh config, two keys (only one is for the git host), a known_hosts
 * file, a bare repo served over a fake `ssh` that enforces host keys and agent keys like a real
 * server would, and an HTTP git server (git http-backend) that requires a token.
 */
export const TOKEN = "glpat-super-secret-123";
export const hasSsh = Bun.which("ssh-agent") !== null && Bun.which("ssh-keygen") !== null;

export function makeGitFixtures() {
  const root = mkdtempSync(join(tmpdir(), "panem-git-"));
  const home = join(root, "home");
  const repos = join(root, "repos");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(repos, "omnihr"), { recursive: true });
  // A real repo with a "dev" branch.
  sh(root, `git init -q --bare -b main ${join(repos, "omnihr/service.git")}`);
  sh(
    root,
    `git init -q -b dev seed && cd seed && echo hi > f && git add f && ${G} commit -qm c && git push -q ${join(repos, "omnihr/service.git")} dev`,
  );
  if (hasSsh) {
    sh(home, "ssh-keygen -q -t ed25519 -N '' -C gitkey -f .ssh/gitlab_key");
    sh(home, "ssh-keygen -q -t ed25519 -N '' -C personal -f .ssh/id_ed25519");
    sh(home, "ssh-keygen -q -t ed25519 -N 'pass' -C locked -f .ssh/locked_key");
    sh(root, "ssh-keygen -q -t ed25519 -N '' -C host -f hostkey");
    writeFileSync(
      join(home, ".ssh/known_hosts"),
      `gitlab.com ${readFileSync(join(root, "hostkey.pub"), "utf8")}`,
    );
  }
  writeFileSync(
    join(home, ".ssh/config"),
    [
      "Host gitlab-work",
      "  HostName gitlab.com",
      "  User git",
      `  IdentityFile ${join(home, ".ssh/gitlab_key")}`,
      "Host gitlab.com",
      `  IdentityFile ${join(home, ".ssh/gitlab_key")}`,
      "Host locked.example",
      `  IdentityFile ${join(home, ".ssh/locked_key")}`,
      "Host nokey.example",
      `  IdentityFile ${join(home, ".ssh/does_not_exist")}`,
      "",
    ].join("\n"),
  );
  // Fake ssh: resolve the alias from -F, check the host key and the agent's keys, then serve.
  const fakeSsh = join(root, "fake-ssh");
  writeFileSync(
    fakeSsh,
    `#!/usr/bin/env bash
cfg="" kh=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -F) cfg="$2"; shift 2 ;;
    -o) case "$2" in UserKnownHostsFile=*) kh="\${2#UserKnownHostsFile=}" ;; esac; shift 2 ;;
    -p) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
dest="\${args[0]}"; cmd="\${args[*]:1}"
host="\${dest#*@}"
real="$(awk -v h="$host" '$1=="Host"{m=($2==h)} m&&$1=="HostName"{print $2}' "$cfg")"
[ -n "$real" ] || real="$host"
grep -q "^$real " "$kh" 2>/dev/null || { echo "Host key verification failed." >&2; exit 255; }
want="$(cut -d' ' -f2 ${JSON.stringify(join(home, ".ssh/gitlab_key.pub"))})"
ssh-add -L 2>/dev/null | grep -q "$want" || { echo "git@$real: Permission denied (publickey)." >&2; exit 255; }
path="$(printf '%s' "$cmd" | sed -E "s/^git-upload-pack '?([^']*)'?$/\\1/")"
exec git-upload-pack ${JSON.stringify(repos)}/"$path"
`,
  );
  chmodSync(fakeSsh, 0o755);
  // HTTPS-like server: git http-backend behind Basic auth with the token.
  const http = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      const [user, pass] = Buffer.from(auth.replace(/^Basic /, ""), "base64")
        .toString()
        .split(":");
      if (pass !== TOKEN || user !== "oauth2") {
        return new Response("denied", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="git"' },
        });
      }
      const u = new URL(req.url);
      const p = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env.PATH!,
          GIT_PROJECT_ROOT: repos,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers.get("content-type") ?? "",
        },
        stdin: req.body ? new Uint8Array(await req.arrayBuffer()) : "ignore",
        stdout: "pipe",
      });
      const out = Buffer.from(await new Response(p.stdout).arrayBuffer());
      const split = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, split).toString();
      const headers = new Headers();
      let status = 200;
      for (const line of head.split("\r\n")) {
        const [k, ...v] = line.split(":");
        if (k!.toLowerCase() === "status") status = Number.parseInt(v.join(":"), 10);
        else headers.set(k!, v.join(":").trim());
      }
      return new Response(out.subarray(split + 4), { status, headers });
    },
  });
  const access = (extra: Record<string, unknown> = {}) =>
    new GitAccess({
      sshConfig: join(home, ".ssh/config"),
      home,
      knownHostsFiles: [join(home, ".ssh/known_hosts")],
      sshBin: fakeSsh,
      gitConfig: [`url.http://127.0.0.1:${http.port}/.insteadOf=https://git.test/`],
      timeoutMs: 10_000,
      ...extra,
    });
  return { root, home, repos, http, access, stop: () => http.stop(true) };
}
