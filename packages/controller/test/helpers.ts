import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@panem/core";
import type { Forwarders } from "../src/forwarders";
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

/** A bare "origin" workspace repo with one template and some memory, plus a scratch clone. */
export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "panem-ctl-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  sh(root, `git init -q --bare -b main ${origin}`);
  mkdirSync(join(seed, "templates/shop/.devcontainer"), { recursive: true });
  mkdirSync(join(seed, "memory/api"), { recursive: true });
  writeFileSync(
    join(seed, "templates/shop/template.json"),
    JSON.stringify({
      description: "Shop stack",
      repos: [
        { name: "web", url: "https://example.com/web.git" },
        { name: "api", url: "https://example.com/api.git", ref: "develop", primary: true },
      ],
    }),
  );
  writeFileSync(join(seed, "templates/shop/.devcontainer/devcontainer.json"), "{}");
  mkdirSync(join(seed, "templates/broken"), { recursive: true });
  writeFileSync(join(seed, "templates/broken/template.json"), '{"repos": []}');
  writeFileSync(join(seed, "memory/api/MEMORY.md"), "# API memory\n- uses postgres\n");
  writeFileSync(join(seed, ".gitattributes"), "memory/** merge=union\n");
  writeFileSync(join(seed, "CLAUDE.md"), "be nice\n");
  sh(
    seed,
    `git init -q -b main && git add -A && ${G} commit -qm seed && git push -q ${origin} main`,
  );
  return {
    root,
    origin,
    /** Clone origin fresh and return its path. */
    clone(name: string) {
      const dir = join(root, name);
      sh(root, `git clone -q ${origin} ${name}`);
      return dir;
    },
    /** Push a change from "another machine". */
    pushFrom(name: string, file: string, content: string) {
      const dir = join(root, name);
      sh(root, `rm -rf ${name} && git clone -q ${origin} ${name}`);
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), content);
      sh(dir, `git add -A && ${G} commit -qm ext && git push -q origin main`);
    },
    read(file: string) {
      return sh(root, `git --git-dir=${origin} show main:${file}`);
    },
    log() {
      return sh(root, `git --git-dir=${origin} log --format=%s main`);
    },
  };
}

export async function makeController(opts: {
  dataDir?: string;
  origin: string;
  root: string;
  forwarders?: Forwarders;
  relaySecret?: string;
  agentEnv?: Record<string, string>;
}) {
  const backend = new MockBackend();
  await backend.addMachine({ name: "m-vps", host: "vps" });
  await backend.addMachine({ name: "m-mac", host: "mac" });
  const probe = new StaticProbe({ vps: "online", mac: "online" });
  const config: Config = {
    forwarder: { portRange: [7600, 7699], controlPort: 7599, blockSize: 10 },
    workspaceRepoUrl: opts.origin,
    workspaceBranch: "main",
    apiToken: TOKEN,
    claudeOauthToken: "oauth-xyz",
    port: 0,
    devpodPath: "devpod",
    listen: ["127.0.0.1"],
    relaySecret: opts.relaySecret,
    agentEnv: opts.agentEnv ?? {},
  };
  const dataDir = opts.dataDir ?? mkdtempSync(join(opts.root, "data-"));
  const ctl = await createController({
    config,
    dataDir,
    backend,
    probe,
    forwarders: opts.forwarders ?? noForwarders,
    log: () => {},
  });
  await ctl.service.refresh();
  const req = (method: string, path: string, body?: unknown) =>
    ctl.app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...ctl, backend, probe, dataDir, req };
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
