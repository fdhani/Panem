import { join } from "node:path";
import { DevPodBackend } from "@panem/backend-devpod";
import { type Config, type PodBackend, dataDir as defaultDataDir } from "@panem/core";
import { createApp } from "./api";
import { WorkspaceRepo } from "./git";
import { MockBackend } from "./mock-backend";
import { type HostProbe, StaticProbe, TailscaleProbe, tailscaleIPv4 } from "./probe";
import { PodService } from "./service";
import { JobStore, PodStore } from "./stores";
import { Templates } from "./templates";
import { loadUi } from "./ui";

export interface ControllerOptions {
  config: Config;
  dataDir?: string;
  backend?: PodBackend;
  probe?: HostProbe;
  log?: (msg: string) => void;
}

export async function createController(o: ControllerOptions) {
  const dir = o.dataDir ?? defaultDataDir();
  const mock = process.env.PANEM_BACKEND === "mock";
  const backend =
    o.backend ?? (mock ? await seededMock() : new DevPodBackend({ bin: o.config.devpodPath }));
  const probe = o.probe ?? (mock ? new StaticProbe() : new TailscaleProbe());
  const repo = new WorkspaceRepo(
    join(dir, "workspace"),
    o.config.workspaceRepoUrl,
    o.config.workspaceBranch,
  );
  const templates = new Templates(repo);
  const service = new PodService({
    backend,
    repo,
    templates,
    probe,
    pods: await PodStore.open(dir),
    jobs: await JobStore.open(dir),
    claudeOauthToken: o.config.claudeOauthToken,
    log: o.log,
  });
  const app = createApp({ service, templates, apiToken: o.config.apiToken, ui: await loadUi() });
  return { app, service, backend, repo };
}

async function seededMock(): Promise<MockBackend> {
  const m = new MockBackend();
  m.delayMs = 1500;
  await m.addMachine({ name: "m-homeserver", host: "homeserver" });
  await m.addMachine({ name: "m-vps", host: "vps", user: "dev" });
  return m;
}

export async function serve(config: Config) {
  const { app, service, backend } = await createController({ config });
  if (backend instanceof DevPodBackend) {
    try {
      const v = await backend.version();
      if (!v.pinned) console.warn(`[panem] devpod ${v.version} is not the tested version`);
    } catch (e) {
      console.warn(`[panem] devpod not usable: ${e instanceof Error ? e.message : e}`);
    }
  }
  await service.resumeJobs();
  const poll = async () => {
    try {
      await service.refresh();
    } catch (e) {
      console.warn(`[panem] refresh failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  await poll();
  const timer = setInterval(poll, 5000);

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
