import { join } from "node:path";
import { DevPodBackend } from "@panem/backend-devpod";
import { type Config, type PodBackend, dataDir as defaultDataDir, loadConfig } from "@panem/core";
import { createApp } from "./api";
import { Credentials } from "./credentials";
import { ForwarderManager, type Forwarders } from "./forwarders";
import { GitAccess } from "./git-access";
import { MockBackend, MockForwarders } from "./mock-backend";
import { type HostProbe, StaticProbe, TailscaleProbe, tailscaleIPv4 } from "./probe";
import { PodService } from "./service";
import { SshShell } from "./shell";
import { Sources } from "./sources";
import { JobStore, PodStore } from "./stores";
import { Templates } from "./templates";
import { loadUi } from "./ui";
import { Workspace } from "./workspace";

export interface ControllerOptions {
  config: Config;
  dataDir?: string;
  backend?: PodBackend;
  probe?: HostProbe;
  forwarders?: Forwarders;
  /** Where the config came from, to pick up credential changes without a restart. */
  configPath?: string;
  /** Git access for pods; default: real (DevPod), none (mock backend). Tests inject their own. */
  git?: GitAccess | null;
  /** Time limit per before-destroy hook, in seconds (tests). */
  hookTimeoutSec?: number;
  /** Time limit per workspace hook (panem.json "hooks"), in seconds (default 120; tests). */
  workspaceHookTimeoutSec?: number;
  log?: (msg: string) => void;
}

export async function createController(o: ControllerOptions) {
  const dir = o.dataDir ?? defaultDataDir();
  const mock = process.env.PANEM_BACKEND === "mock";
  const backend =
    o.backend ?? (mock ? await seededMock() : new DevPodBackend({ bin: o.config.devpodPath }));
  const probe = o.probe ?? (mock ? new StaticProbe() : new TailscaleProbe());
  const forwarders =
    o.forwarders ??
    (backend instanceof MockBackend
      ? new MockForwarders(backend)
      : new ForwarderManager(o.config, new SshShell()));
  // Read fresh, so `panem workspace init` applies without a restart.
  const workspace = new Workspace(
    async () =>
      o.configPath
        ? (await loadConfig(o.configPath).catch(() => o.config)).workspaceDir
        : o.config.workspaceDir,
    (o.workspaceHookTimeoutSec ?? 120) * 1000,
  );
  const templates = new Templates(workspace);
  const sources = new Sources({ dataDir: dir, workspace });
  const credentials = new Credentials(o.config, o.configPath);
  const service = new PodService({
    backend,
    workspace,
    dataDir: dir,
    // Mock pods clone nothing real; DevPod pods get managed git access.
    git:
      o.git === null
        ? undefined
        : (o.git ?? (backend instanceof DevPodBackend ? new GitAccess() : undefined)),
    templates,
    probe,
    pods: await PodStore.open(dir),
    jobs: await JobStore.open(dir),
    // Re-read at each summon, so `panem env set` and the web UI take effect without a restart.
    credentials: () => credentials.all(),
    relaySecret: o.config.relaySecret,
    forwarders,
    sources,
    hookTimeoutSec: o.hookTimeoutSec,
    log: o.log,
  });
  const app = createApp({
    service,
    templates,
    credentials,
    workspace,
    apiToken: o.config.apiToken,
    ui: await loadUi(),
    log: o.log,
  });
  return { app, service, backend, workspace, credentials };
}

async function seededMock(): Promise<MockBackend> {
  const m = new MockBackend();
  m.delayMs = 1500;
  // Development: PANEM_MOCK_AGENTS='[{"id":"x","label":"X","connect":[...]}]' to try other agents.
  if (process.env.PANEM_MOCK_AGENTS) m.agentsJson = process.env.PANEM_MOCK_AGENTS;
  await m.addMachine({ name: "m-homeserver", host: "homeserver" });
  await m.addMachine({ name: "m-vps", host: "vps", user: "dev" });
  return m;
}

export async function serve(config: Config, configPath?: string) {
  const { app, service, backend } = await createController({ config, configPath });
  if (backend instanceof DevPodBackend) {
    // Panem scopes git access itself: stop DevPod adding all ~/.ssh keys to forwarded agents
    // and forwarding the controller's git credential store to pods.
    await backend
      .configureContext()
      .then(() =>
        console.log(
          "[panem] DevPod context: SSH_ADD_PRIVATE_KEYS=false, SSH_INJECT_GIT_CREDENTIALS=false",
        ),
      )
      .catch((e) => console.warn(`[panem] could not set DevPod context options: ${e}`));
  }
  if (backend instanceof DevPodBackend) {
    try {
      const v = await backend.version();
      if (!v.pinned) console.warn(`[panem] devpod ${v.version} is not the tested version`);
    } catch (e) {
      console.warn(`[panem] devpod not usable: ${e instanceof Error ? e.message : e}`);
    }
  }
  await service.resumeJobs();
  if (!config.relaySecret || !config.forwarderToken) {
    console.warn("[panem] port forwarding off: restart `panem serve` to add its secrets");
  }
  const poll = async () => {
    try {
      await service.refresh();
    } catch (e) {
      console.warn(`[panem] refresh failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  await poll();
  const timer = setInterval(poll, 5000);
  // Make sure every reachable machine runs the matching forwarder (idempotent).
  if (config.relaySecret && config.forwarderToken) {
    for (const m of service.machines().filter((x) => x.status !== "offline")) {
      service.repairMachine(m.name, m).catch(() => {});
    }
  }

  // Only localhost and the Tailscale IP: never 0.0.0.0.
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const bound = new Set<string>();
  const bind = (hostname: string) => {
    if (bound.has(hostname)) return;
    const s = Bun.serve({ hostname, port: config.port, fetch: app.fetch, idleTimeout: 0 });
    bound.add(hostname);
    servers.push(s);
    console.log(`[panem] listening on http://${s.hostname}:${s.port}`);
  };
  for (const h of config.listen) bind(h);
  // tailscaled may come up after us at boot: keep looking for its IP.
  const bindTailscale = async () => {
    const ip = await tailscaleIPv4();
    if (ip) {
      try {
        bind(ip);
      } catch (e) {
        console.warn(`[panem] could not bind ${ip}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return ip;
  };
  if (!(await bindTailscale())) console.warn("[panem] no Tailscale IP yet; serving localhost only");
  const tsTimer = setInterval(bindTailscale, 30_000);

  const stop = async () => {
    clearInterval(timer);
    clearInterval(tsTimer);
    for (const s of servers) s.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { servers, service };
}
