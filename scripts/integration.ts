// End-to-end test against a real DevPod + Docker (run in CI; needs network for images).
// Exercises: machine add, up with the claude-code Feature, context injection, stop/start,
// port exposure through the per-machine forwarder, memory export to a bare git repo, delete.
// Needs the forwarder image built locally first (see .github/workflows/ci.yml).
//   DEVPOD=/path/to/devpod bun scripts/integration.ts
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevPodBackend } from "@panem/backend-devpod";
import { ForwarderManager, SshShell, WorkspaceRepo, exportMemory } from "@panem/controller";
import { Config, PANEM_VERSION } from "@panem/core";
import { type PodMeta, claudeProjectDir, repoPath } from "@panem/core";

const root = mkdtempSync(join(tmpdir(), "panem-it-"));
const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd });
  if (p.exitCode !== 0) throw new Error(`${cmd}\n${p.stderr}`);
  return p.stdout.toString();
};
const step = (s: string) => console.log(`\n=== ${s}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---- fixture workspace repo ----
const origin = join(root, "origin.git");
const src = join(root, "ws");
const tpl = join(src, "templates/it/.devcontainer");
mkdirSync(tpl, { recursive: true });
mkdirSync(join(src, "memory/hello"), { recursive: true });
cpSync(join(import.meta.dir, "../features/claude-code/src/claude-code"), join(tpl, "claude-code"), {
  recursive: true,
});
writeFileSync(
  join(tpl, "devcontainer.json"),
  JSON.stringify({
    image: "mcr.microsoft.com/devcontainers/base:ubuntu",
    remoteUser: "vscode",
    features: { "./claude-code": { installClaude: false } },
  }),
);
writeFileSync(join(src, "CLAUDE.md"), "# integration\n");
writeFileSync(join(src, "memory/hello/MEMORY.md"), "- seeded fact\n");
writeFileSync(join(src, ".gitattributes"), "memory/** merge=union\n");
sh(root, `git init -q --bare -b main ${origin}`);
sh(
  src,
  `git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed && git push -q ${origin} main`,
);

const dp = new DevPodBackend({ bin: process.env.DEVPOD ?? "devpod" });
const repo = new WorkspaceRepo(join(root, "clone"), origin, "main");
const workspaceSha = await repo.sync();
const id = `it-${Date.now().toString(36)}`;
const meta: PodMeta = {
  id,
  template: "it",
  machine: "m-local",
  repos: [{ name: "hello", url: "https://github.com/octocat/Hello-World.git", ref: "master" }],
  workspaceSha,
  createdAt: new Date().toISOString(),
};
const RELAY_SECRET = "integration-relay-secret-0123";
const cfg = Config.parse({
  workspaceRepoUrl: origin,
  apiToken: "integration-api-token-0123",
  relaySecret: RELAY_SECRET,
  forwarderToken: "integration-forwarder-0123",
  // Built locally by CI before this script runs.
  forwarder: { image: `ghcr.io/fdhani/panem/forwarder:${PANEM_VERSION}` },
});
// No Tailscale in CI: the forwarder publishes on 127.0.0.1.
const forwarders = new ForwarderManager(cfg, new SshShell(), {
  localAddress: async () => undefined,
});
const local = { name: "m-local", host: "local" };
const run = async (cmd: string) => {
  const r = await dp.exec(id, cmd);
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim(), err: r.stderr };
};

try {
  step(`devpod ${(await dp.version()).version}`);
  step("add machine");
  if (!(await dp.listMachines()).some((m) => m.name === "m-local")) {
    await dp.addMachine({ name: "m-local", host: "local" });
  }
  assert(
    (await dp.listMachines()).some((m) => m.name === "m-local"),
    "m-local listed",
  );

  step("up");
  await dp.up({
    id,
    machine: "m-local",
    source: src,
    sourceRef: "main",
    devcontainerPath: "templates/it/.devcontainer/devcontainer.json",
    env: {
      PANEM_POD: JSON.stringify(meta),
      CLAUDE_CODE_OAUTH_TOKEN: "dummy",
      PANEM_RELAY_SECRET: RELAY_SECRET,
    },
  });
  const listed = (await dp.list()).find((p) => p.id === id);
  assert(listed?.status === "running", `running after up (got ${listed?.status})`);

  step("context injected");
  if ((await run("test -d /codebase/hello/.git")).code !== 0) {
    // Print what the pod looks like so a CI failure is diagnosable without a debugger.
    for (const cmd of [
      "id; echo HOME=$HOME; pwd",
      "env | grep -E '^PANEM|^DEVPOD|^REMOTE' | sed 's/=.*SECRET.*/=<redacted>/' || true",
      "ls -la /codebase ~/.panem /usr/local/share/panem 2>&1",
      "cat ~/.panem/post-create.log 2>&1",
      "ls -la ~ ~/.claude 2>&1",
      "ls / ; ls /workspaces 2>&1 | head",
    ]) {
      const r = await run(cmd);
      console.log(`\n$ ${cmd}\n${r.out}\n${r.err}`);
    }
    assert(false, "repo cloned");
  }
  assert((await run("git -C /codebase/hello rev-parse --abbrev-ref HEAD")).out === "master", "ref");
  assert((await run("cat ~/.claude/CLAUDE.md")).out === "# integration", "CLAUDE.md");
  const memDir = `~/.claude/projects/${claudeProjectDir(repoPath("hello"))}/memory`;
  assert((await run(`cat ${memDir}/MEMORY.md`)).out === "- seeded fact", "memory seeded");
  assert((await run("jq -r .id ~/.panem/pod.json")).out === id, "pod.json");

  step("stop / start keeps disk");
  await run(`echo '- learned in pod' >> ${memDir}/MEMORY.md`);
  await dp.stop(id);
  assert((await dp.status(id)) === "stopped", "stopped");
  await dp.start(id);
  assert((await dp.status(id)) === "running", "running again");
  assert((await run(`cat ${memDir}/MEMORY.md`)).out.includes("learned in pod"), "memory kept");

  step("ports exposed on the machine through the forwarder");
  await forwarders.ensure(local);
  // A loopback-only server inside the pod, like a dev server on localhost.
  await run(
    // (socat rewrites backslashes and double quotes in SYSTEM:, hence plain echo.)
    "setsid nohup socat TCP-LISTEN:5173,bind=127.0.0.1,fork,reuseaddr SYSTEM:'sed -n /^.$/q; echo HTTP/1.0 200 OK; echo; echo from-pod' >/dev/null 2>&1 < /dev/null &",
  );
  // Ports are closed until switched on.
  await forwarders.setExposed(local, id, [5173]);
  let hostPort: number | undefined;
  for (let i = 0; i < 40 && !hostPort; i++) {
    await Bun.sleep(1000);
    const st = await forwarders.state(local).catch(() => undefined);
    hostPort = st?.pods
      .find((p) => p.id === id)
      ?.ports.find((p) => p.podPort === 5173 && p.live)?.hostPort;
  }
  assert(hostPort, "port 5173 mapped by the forwarder");
  const body = await (await fetch(`http://127.0.0.1:${hostPort}/`)).text();
  assert(body.includes("from-pod"), `proxied response (got ${JSON.stringify(body)})`);

  step("export");
  const r = await exportMemory(dp, repo, meta);
  assert(r.commit, "export committed");
  const exported = sh(root, `git --git-dir=${origin} show main:memory/hello/MEMORY.md`);
  assert(exported.includes("- learned in pod") && exported.includes("- seeded fact"), "merged");

  step("delete");
  await dp.delete(id);
  assert(!(await dp.list()).some((p) => p.id === id), "deleted");
  await forwarders.release(local, id);
  assert(!(await forwarders.state(local)).pods.some((p) => p.id === id), "ports released");
  await forwarders.remove(local);
  console.log("\nintegration test passed");
} catch (e) {
  console.error(e);
  await dp.delete(id, { force: true }).catch(() => {});
  await forwarders.remove(local).catch(() => {});
  process.exit(1);
}
