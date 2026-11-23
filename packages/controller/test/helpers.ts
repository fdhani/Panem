import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, saveConfig } from "@panem/core";
import type { Forwarders } from "../src/forwarders";
import type { GitAccess } from "../src/git-access";
import { MockBackend } from "../src/mock-backend";
import { StaticProbe } from "../src/probe";
import { createController } from "../src/server";

export const TOKEN = "test-token-0123456789";

export function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

const G = "git -c user.email=t@t -c user.name=t";

/** A workspace folder with one template and some memory. */
export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "panem-ctl-"));
  const dir = join(root, "workspace");
  const write = (file: string, content: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  write(
    "templates/shop/template.json",
    JSON.stringify({
      description: "Shop stack",
      repos: [
        { name: "web", url: "https://example.com/web.git" },
        { name: "api", url: "https://example.com/api.git", ref: "develop", primary: true },
      ],
    }),
  );
  write("templates/shop/.devcontainer/devcontainer.json", "{}");
  write("templates/broken/template.json", '{"repos": []}');
  write("memory/api/MEMORY.md", "# API memory\n- uses postgres\n");
  write("CLAUDE.md", "be nice\n");
  return {
    root,
    dir,
    /** Change a file in the workspace (the name says who; kept for readability). */
    pushFrom(_who: string, file: string, content: string) {
      write(file, content);
    },
    read(file: string) {
      return readFileSync(join(dir, file), "utf8");
    },
    /** A fingerprint of every file in the workspace: equal before/after means nothing changed. */
    log() {
      return sh(dir, "find . -type f -print0 | sort -z | xargs -0 sha1sum");
    },
  };
}

export async function makeController(opts: {
  dataDir?: string;
  /** The workspace folder; omit for a controller with no workspace yet. */
  dir?: string;
  root: string;
  forwarders?: Forwarders;
  relaySecret?: string;
  agentEnv?: Record<string, string>;
  hookTimeoutSec?: number;
  workspaceHookTimeoutSec?: number;
  /** Keep the config in this file (written here, 0600), as `panem serve` does. */
  configPath?: string;
  /** Managed git access (see git-fixtures.ts); default none, like mock mode. */
  git?: GitAccess;
}) {
  const backend = new MockBackend();
  await backend.addMachine({ name: "m-vps", host: "vps" });
  await backend.addMachine({ name: "m-mac", host: "mac" });
  const probe = new StaticProbe({ vps: "online", mac: "online" });
  const config: Config = {
    forwarder: { portRange: [7600, 7699], controlPort: 7599, blockSize: 10 },
    workspaceDir: opts.dir,
    apiToken: TOKEN,
    claudeOauthToken: "oauth-xyz",
    port: 0,
    devpodPath: "devpod",
    listen: ["127.0.0.1"],
    relaySecret: opts.relaySecret,
    agentEnv: opts.agentEnv ?? {},
    agentEnvUpdated: {},
  };
  const dataDir = opts.dataDir ?? mkdtempSync(join(opts.root, "data-"));
  /** Everything the controller logged. */
  const logs: string[] = [];
  if (opts.configPath) await saveConfig(config, opts.configPath);
  const ctl = await createController({
    config,
    configPath: opts.configPath,
    dataDir,
    backend,
    probe,
    forwarders: opts.forwarders ?? noForwarders,
    hookTimeoutSec: opts.hookTimeoutSec,
    workspaceHookTimeoutSec: opts.workspaceHookTimeoutSec,
    git: opts.git,
    log: (m) => logs.push(m),
  });
  await ctl.service.refresh();
  const req = (method: string, path: string, body?: unknown) =>
    ctl.app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...ctl, backend, probe, dataDir, req, logs };
}

/** Wait until the predicate holds (pods settle asynchronously). */
export async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

/** Forwarding switched off: what an old config without secrets gets. */
export const noForwarders: Forwarders = {
  enabled: false,
  linkHost: async (m) => m.host,
  state: async () => {
    throw new Error("disabled");
  },
  ensure: async () => ({ status: "disabled" }),
  release: async () => {},
  setExposed: async () => {
    throw new Error("disabled");
  },
  remove: async () => {},
};

/** An extra git repo (e.g. a claude-overlay source), optionally seeded with files. */
export function makeRepo(root: string, name: string, files?: Record<string, string>) {
  const origin = join(root, `${name}.git`);
  sh(root, `git init -q --bare -b main ${origin}`);
  if (files) {
    const seed = join(root, `${name}-seed`);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(seed, p, ".."), { recursive: true });
      writeFileSync(join(seed, p), c);
    }
    sh(
      seed,
      `git init -q -b main && git add -A && ${G} commit -qm seed && git push -q ${origin} main`,
    );
  }
  return {
    origin,
    read: (file: string) => sh(root, `git --git-dir=${origin} show main:${file}`),
    log: () => sh(root, `git --git-dir=${origin} log --format=%s main 2>/dev/null || true`),
  };
}
