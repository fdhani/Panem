// End-to-end test against a real DevPod + Docker (run in CI; needs network for images).
// Exercises: machine add, up with the claude-code Feature, upload over devpod ssh, sync rules
// copying in from three kinds of source (workspace repo, an overlay git repo, a folder),
// stop/start, port exposure through the per-machine forwarder, export back to all three
// sources, delete.
// Needs the forwarder image built locally first (see .github/workflows/ci.yml).
//   DEVPOD=/path/to/devpod bun scripts/integration.ts
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevPodBackend } from "@panem/backend-devpod";
import {
  ForwarderManager,
  Sources,
  SshShell,
  WorkspaceRepo,
  exportPod,
  syncIn,
} from "@panem/controller";
import { Config, PANEM_VERSION, resolveSync } from "@panem/core";
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
// Only the agent Feature: it must bring the Panem base along by itself (as existing templates
// rely on).
cpSync(join(import.meta.dir, "../features/src/claude-code"), join(tpl, "claude-code"), {
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

// An overlay repo for the code repo "hello" (Hello-World tracks README, so that one must be
// skipped), and a folder source on the "controller".
const G = "git -c user.email=t@t -c user.name=t";
const overlayOrigin = join(root, "overlay.git");
const overlaySeed = join(root, "overlay-seed");
mkdirSync(join(overlaySeed, "hello/.specify"), { recursive: true });
writeFileSync(join(overlaySeed, "hello/CLAUDE.md"), "# hello overlay\n");
writeFileSync(join(overlaySeed, "hello/.specify/constitution.md"), "be kind\n");
writeFileSync(join(overlaySeed, "hello/README"), "overlay must not replace this\n");
sh(root, `git init -q --bare -b main ${overlayOrigin}`);
sh(
  overlaySeed,
  `git init -q -b main && git add -A && ${G} commit -qm seed && git push -q ${overlayOrigin} main`,
);
const folder = join(root, "claude-context");
mkdirSync(join(folder, "skills/review"), { recursive: true });
writeFileSync(join(folder, "skills/review/SKILL.md"), "review\n");
writeFileSync(join(folder, "notes.md"), "base\n");
const panem = {
  sources: { overlay: { git: overlayOrigin, ref: "main" }, local: { dir: folder } },
  sync: [
    { from: "CLAUDE.md", to: "~/.claude/CLAUDE.md" },
    { from: "memory/{repo}/**", to: "~/.claude/projects/-codebase-{repo}/memory/**", flow: "both" },
    { source: "overlay", from: "{repo}/**", to: "/codebase/{repo}/**", flow: "both" },
    { source: "local", from: "skills/**", to: "~/.claude/skills/**" },
    { source: "local", from: "notes.md", to: "~/notes.md", flow: "both" },
  ],
};
writeFileSync(join(src, "panem.json"), JSON.stringify(panem));
sh(root, `git init -q --bare -b main ${origin}`);
sh(
  src,
  `git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed && git push -q ${origin} main`,
);

const dp = new DevPodBackend({ bin: process.env.DEVPOD ?? "devpod" });
const repo = new WorkspaceRepo(join(root, "clone"), origin, "main");
const workspaceSha = await repo.sync();
const id = `it-${Date.now().toString(36)}`;
let meta: PodMeta = {
  id,
  template: "it",
  machine: "m-local",
  repos: [{ name: "hello", url: "https://github.com/octocat/Hello-World.git", ref: "master" }],
  workspaceSha,
  createdAt: new Date().toISOString(),
  sync: resolveSync(panem, { name: "it" }),
};
const sources = new Sources({ dataDir: join(root, "data"), workspace: repo });
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
      // What the controller sends for a template without "env": just the Claude token.
      PANEM_AGENT_ENV: "CLAUDE_CODE_OAUTH_TOKEN",
    },
  });
  const listed = (await dp.list()).find((p) => p.id === id);
  assert(listed?.status === "running", `running after up (got ${listed?.status})`);

  step("upload over devpod ssh");
  const blob = crypto.getRandomValues(new Uint8Array(300_000));
  const want = new Bun.CryptoHasher("sha256").update(blob).digest("hex");
  const up = await dp.upload(id, blob, "sha256sum | cut -d' ' -f1");
  assert(up.exitCode === 0, `upload ran (${up.stderr})`);
  assert(new TextDecoder().decode(up.stdout).trim() === want, "uploaded bytes intact");
  console.log(
    `devpod ssh stdin passthrough: ${(dp as unknown as { stdinWorks?: boolean }).stdinWorks ? "yes" : "no (chunked fallback)"}`,
  );
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
  // Setup must not have copied context itself: that's the controller's job now.
  assert((await run("test -e ~/.claude/CLAUDE.md")).code !== 0, "no context before copy-in");

  step("copy-in from three sources, then the start hook");
  const synced = await syncIn({ backend: dp, sources }, meta);
  meta = { ...meta, sync: synced.sync, workspaceSha: synced.workspaceSha };
  console.log(`copied ${synced.files} file(s); notes: ${synced.notes.join(" | ") || "none"}`);
  await dp.runHook(id, "start");
  assert((await run("cat ~/.claude/CLAUDE.md")).out === "# integration", "CLAUDE.md");
  const memDir = `~/.claude/projects/${claudeProjectDir(repoPath("hello"))}/memory`;
  assert((await run(`cat ${memDir}/MEMORY.md`)).out === "- seeded fact", "memory seeded");
  assert((await run("cat /codebase/hello/CLAUDE.md")).out === "# hello overlay", "overlay file");
  assert(
    !(await run("cat /codebase/hello/README")).out.includes("overlay must not"),
    "tracked file not overwritten",
  );
  assert(
    synced.notes.some((n) => n.includes("hello/README")),
    "tracked-file skip reported",
  );
  assert(
    (await run("git -C /codebase/hello status --porcelain")).out === "",
    "overlay hidden from git",
  );
  assert((await run("cat ~/.claude/skills/review/SKILL.md")).out === "review", "folder source");
  assert((await run("jq -r .id ~/.panem/pod.json")).out === id, "pod.json");
  assert(
    (await run("jq -r 'map(.id) | join(\",\")' ~/.panem/agents.json")).out === "claude-code",
    "agents.json lists the claude-code agent (base installed by the agent Feature)",
  );
  assert(
    (await run("cut -d= -f1 ~/.config/panem/env | sort | tr '\\n' ' '")).out ===
      "CLAUDE_CODE_OAUTH_TOKEN PANEM_RELAY_SECRET",
    "only the opted-in credentials were saved",
  );
  assert(
    (await run("jq -r .sync.bases.overlay.commit ~/.panem/pod.json")).out.length === 40,
    "pod.json records merge bases",
  );

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

  step("export to all three sources");
  await run(
    "mkdir -p /codebase/hello/specs && echo 'spec from pod' > /codebase/hello/specs/001.md",
  );
  await run("printf 'base\\npod\\n' > ~/notes.md");
  const r = await exportPod({ backend: dp, sources }, meta);
  console.log(`exported: ${r.files.join(", ")}`);
  const exported = sh(root, `git --git-dir=${origin} show main:memory/hello/MEMORY.md`);
  assert(exported.includes("- learned in pod") && exported.includes("- seeded fact"), "merged");
  assert(
    sh(root, `git --git-dir=${overlayOrigin} show main:hello/specs/001.md`).trim() ===
      "spec from pod",
    "overlay repo got the new spec",
  );
  assert(
    sh(root, `cat ${join(folder, "notes.md")}`).includes("pod"),
    "folder source got the notes",
  );

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
