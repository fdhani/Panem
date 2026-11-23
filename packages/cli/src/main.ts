#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Machine, MachineLogin, Pod } from "@panem/core";
import {
  Config,
  EnvName,
  PANEM_VERSION,
  agentCredentials,
  configPath,
  dataDir,
  loadConfig,
  pickLoginPod,
  removeCredential,
  saveConfig,
  setCredential,
  updateConfig,
  upgradeConfig,
} from "@panem/core";
import { defineCommand, runMain } from "citty";
import { client, table } from "./client";
import { SCAFFOLD, WORKSPACE_WARN_BYTES } from "./scaffold";

export const VERSION = PANEM_VERSION;

const secret = () => randomBytes(24).toString("base64url");

const serve = defineCommand({
  meta: { name: "serve", description: "Run the controller (API + web UI)" },
  async run() {
    const { serve } = await import("@panem/controller");
    const { cfg, notes } = await upgradeConfig(secret);
    for (const n of notes) console.log(`[panem] ${n}`);
    if (cfg.workspaceRepoUrl && !cfg.workspaceDir)
      throw new Error(movedWorkspace(cfg.workspaceRepoUrl));
    await serve(cfg, configPath());
    await new Promise(() => {});
  },
});

const init = defineCommand({
  meta: {
    name: "init",
    description: "Set up this controller: ~/.config/panem/config.json (API token and secrets)",
  },
  args: {
    port: { type: "string", default: "7420" },
    "claude-token": {
      type: "string",
      description:
        "Deprecated: puts the token in your shell history. Use `panem env set CLAUDE_CODE_OAUTH_TOKEN`",
    },
    devpod: { type: "string", default: "devpod", description: "Path to the devpod binary" },
    force: {
      type: "boolean",
      description: "Start over: new API token and secrets, all credentials removed",
    },
  },
  async run({ args }) {
    const path = configPath();
    if (existsSync(path) && !args.force) {
      throw new Error(
        `${path} exists. --force starts over: a new API token and secrets, and all credentials removed. To change a credential use \`panem env set NAME\`.`,
      );
    }
    if (args["claude-token"]) {
      console.error(
        "warning: --claude-token is deprecated: it leaves the token in your shell history. " +
          "Use `panem env set CLAUDE_CODE_OAUTH_TOKEN` instead.",
      );
    }
    const claudeToken = args["claude-token"] || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const cfg = Config.parse({
      apiToken: secret(),
      relaySecret: secret(),
      forwarderToken: secret(),
      ...(claudeToken
        ? {
            agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
            agentEnvUpdated: { CLAUDE_CODE_OAUTH_TOKEN: new Date().toISOString() },
          }
        : {}),
      port: Number(args.port),
      devpodPath: args.devpod,
    });
    await saveConfig(cfg, path);
    console.log(`wrote ${path}`);
    console.log(`API token (paste into the web UI's Settings): ${cfg.apiToken}`);
    console.log("\nNext:");
    console.log(
      "  - in the folder you want as the workspace (templates, CLAUDE.md, memory): `panem workspace init`",
    );
    if (!claudeToken) {
      console.log(
        "  - no Claude token yet: run `claude setup-token`, then `panem env set CLAUDE_CODE_OAUTH_TOKEN` (or Settings → Agent credentials)",
      );
    }
  },
});

/** Configs from when the workspace was a git repo: how to move to a folder. */
function movedWorkspace(url: string): string {
  return [
    "The workspace is now a folder on the controller, not a git repo. To move yours:",
    `  git clone ${url} ~/panem-workspace`,
    "  cd ~/panem-workspace && panem workspace init",
    "Templates, panem.json and memory/ carry over as they are. The clone stays a git repo, so",
    "you keep its history: commit and push from it whenever you like (Panem won't).",
  ].join("\n");
}

const workspace = defineCommand({
  meta: {
    name: "workspace",
    description: "The workspace folder: templates, files copied into pods, saved memory",
  },
  subCommands: {
    show: defineCommand({
      meta: { name: "show", description: "Print the workspace folder" },
      async run() {
        const cfg = await loadConfig();
        if (cfg.workspaceDir) console.log(cfg.workspaceDir);
        else if (cfg.workspaceRepoUrl) console.log(movedWorkspace(cfg.workspaceRepoUrl));
        else console.log("no workspace yet: run `panem workspace init` in a folder");
      },
    }),
    init: defineCommand({
      meta: {
        name: "init",
        description:
          "Make a folder (default: the current one) the workspace, adding what's missing",
      },
      args: { dir: { type: "positional", required: false, description: "Folder (default: .)" } },
      async run({ args }) {
        await loadConfig(); // there must be a controller config: `panem init` first
        const dir = resolve(String(args.dir ?? "."));
        const why = unsuitableWorkspace(dir);
        if (why) throw new Error(why);
        mkdirSync(dir, { recursive: true });
        const created: string[] = [];
        for (const [file, content] of Object.entries(SCAFFOLD)) {
          const p = join(dir, file);
          if (existsSync(p)) continue;
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, content);
          created.push(file);
        }
        const before = (await loadConfig()).workspaceDir;
        await updateConfig((c) => {
          const { workspaceRepoUrl: _, workspaceBranch: __, ...rest } = c;
          return { ...rest, workspaceDir: dir };
        });
        console.log(
          before === dir
            ? `${dir} is already the workspace`
            : `workspace: ${dir}${before ? ` (was ${before})` : ""}`,
        );
        if (created.length) console.log(`added: ${created.join(", ")}`);
        const size = folderBytes(dir, WORKSPACE_WARN_BYTES);
        if (size > WORKSPACE_WARN_BYTES) {
          console.warn(
            `warning: this folder is over ${WORKSPACE_WARN_BYTES / 1024 / 1024} MB. DevPod uploads the whole workspace to a machine for every pod: keep it to templates, CLAUDE.md, skills and memory.`,
          );
        }
        console.log(
          "DevPod uploads this folder to machines when summoning: keep it small, and keep secrets out (use `panem env set`).",
        );
        if (created.includes("templates/example/template.json")) {
          console.log("Next: edit templates/example/template.json to list your repos.");
        }
      },
    }),
  },
});

/** Why a folder can't be the workspace (it's uploaded to machines), or undefined if it can. */
function unsuitableWorkspace(dir: string): string | undefined {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const d = real(dir);
  if (d === "/") return "the workspace can't be / (it's uploaded to machines for every pod)";
  if (d === real(homedir())) {
    return "the workspace can't be your home folder: it's uploaded to machines for every pod. Use a folder of its own, e.g. ~/panem-workspace";
  }
  for (const secret of [configPath(), dataDir()]) {
    const s = real(secret);
    if (s === d || s.startsWith(`${d}/`)) {
      return `${secret} is inside ${dir}: the workspace is uploaded to machines, so it can't hold Panem's config or data. Use another folder.`;
    }
  }
  return undefined;
}

/** Total size of files under dir, stopping early once over `limit`. */
function folderBytes(dir: string, limit: number): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (total > limit) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

/** Read a secret without it ever being a command-line argument: stdin, or a hidden prompt. */
async function readSecret(name: string): Promise<string> {
  if (!process.stdin.isTTY) return (await new Response(Bun.stdin.stream()).text()).trim();
  process.stdout.write(`${name}: `);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line.trim();
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stdout.write("\n");
  }
}

const envName = (raw: unknown) => {
  const r = EnvName.safeParse(String(raw));
  if (!r.success) throw new Error(`${raw}: ${r.error.issues[0]!.message}`);
  return r.data;
};

const env = defineCommand({
  meta: {
    name: "env",
    description: "Agent credentials on this controller (templates choose which ones pods get)",
  },
  subCommands: {
    set: defineCommand({
      meta: {
        name: "set",
        description: "Set a credential; the value is read from stdin or a prompt",
      },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const name = envName(args.name);
        const value = await readSecret(name);
        if (!value) throw new Error("empty value; nothing saved");
        await setCredential(name, value);
        console.log(`saved ${name} (used by templates that list it in "env"; no restart needed)`);
      },
    }),
    ls: defineCommand({
      meta: { name: "ls", description: "List credential names (never values)" },
      async run() {
        const cfg = await loadConfig();
        const names = Object.keys(agentCredentials(cfg)).sort();
        console.log(names.length ? names.join("\n") : "no credentials set");
      },
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a credential" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const name = envName(args.name);
        await removeCredential(name);
        console.log(`removed ${name}`);
      },
    }),
  },
});

const token = defineCommand({
  meta: { name: "token", description: "Print the API token for the web UI" },
  async run() {
    console.log((await loadConfig()).apiToken);
  },
});

const machine = defineCommand({
  meta: { name: "machine", description: "Manage machines" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List machines" },
      async run() {
        const ms = await (await client()).call<Machine[]>("GET", "/api/machines");
        console.log(
          table([
            ["NAME", "HOST", "STATUS", "FORWARDER"],
            ...ms.map((m) => [
              m.name,
              m.user ? `${m.user}@${m.host}` : m.host,
              m.status,
              m.forwarder
                ? `${m.forwarder.status}${m.forwarder.error ? `: ${m.forwarder.error}` : ""}`
                : "-",
            ]),
          ]),
        );
      },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Register a machine by Tailscale hostname" },
      args: {
        host: { type: "positional", required: true },
        user: { type: "string", description: "SSH user" },
      },
      async run({ args }) {
        const m = await (await client()).call<Machine>("POST", "/api/machines", {
          host: args.host,
          user: args.user,
        });
        console.log(`added ${m.name} (${m.status})`);
      },
    }),
    repair: defineCommand({
      meta: { name: "repair", description: "Redeploy the machine's port forwarder" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const name = String(args.name);
        const st = await (await client()).call<{ status: string }>(
          "POST",
          `/api/machines/${encodeURIComponent(name.startsWith("m-") ? name : `m-${name}`)}/repair`,
        );
        console.log(`forwarder ${st.status}`);
      },
    }),
    prune: defineCommand({
      meta: {
        name: "prune",
        description:
          "List Docker-in-Docker volumes on a machine that no container uses and no pod recorded, and delete them after asking",
      },
      args: {
        name: { type: "positional", required: true },
        yes: { type: "boolean", description: "Don't ask" },
      },
      async run({ args }) {
        const c = await client();
        const raw = String(args.name);
        const name = encodeURIComponent(raw.startsWith("m-") ? raw : `m-${raw}`);
        const list = await c.call<{ name: string; size?: number }[]>(
          "GET",
          `/api/machines/${name}/orphans`,
        );
        if (list.length === 0) {
          console.log(`No unused Docker-in-Docker volumes on ${raw}.`);
          return;
        }
        const total = list.reduce((a, v) => a + (v.size ?? 0), 0);
        console.log(table([["VOLUME", "SIZE"], ...list.map((v) => [v.name, bytes(v.size)])]));
        console.log(`\n${list.length} unused volume(s), ${bytes(total)} in all.`);
        if (!args.yes) {
          process.stdout.write("Delete them? [y/N] ");
          const answer = await new Promise<string>((resolve) => {
            process.stdin.once("data", (d) => resolve(String(d)));
          });
          process.stdin.pause();
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("Nothing deleted.");
            return;
          }
        }
        const r = await c.call<{
          removed: { name: string; size?: number }[];
          skipped: { name: string; reason: string }[];
        }>("POST", `/api/machines/${name}/prune`, { volumes: list.map((v) => v.name) });
        const freed = r.removed.reduce((a, v) => a + (v.size ?? 0), 0);
        console.log(`Deleted ${r.removed.length} volume(s), freeing ${bytes(freed)}.`);
        for (const s of r.skipped) console.log(`Kept ${s.name}: ${s.reason}`);
      },
    }),
    login: defineCommand({
      meta: { name: "login", description: "Same as `panem agent-login <machine> [agent]`" },
      args: {
        name: { type: "positional", required: true },
        agent: { type: "positional", required: false },
      },
      run: ({ args }) =>
        agentLogin({ machine: String(args.name), agent: args.agent as string | undefined }),
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a machine" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        await (await client()).call(
          "DELETE",
          `/api/machines/${encodeURIComponent(String(args.name))}`,
        );
        console.log(`removed ${args.name}`);
      },
    }),
  },
});

/** Bytes as Docker shows them (decimal units). */
function bytes(n?: number): string {
  if (n === undefined) return "?";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)}${units[i]}`;
}

const LOGIN_STATE_TEXT: Record<MachineLogin["state"], string> = {
  "signed-in": "signed in",
  "needs-sign-in": "needs sign-in",
  "no-pods": "no running pod",
  unknown: "check its pods",
};

/**
 * `panem agent-login`: with no machine, list the agents that can be signed in to on each
 * machine; with one, sign an agent in there (or in one pod, with --pod).
 */
async function agentLogin(o: { machine?: string; agent?: string; pod?: string }) {
  const c = await client();
  const machines = await c.call<Machine[]>("GET", "/api/machines");
  if (o.pod) {
    const p = await c.call<Pod>("GET", `/api/pods/${encodeURIComponent(o.pod)}`);
    const withLogin = (p.agents ?? []).filter((a) => a.login);
    const a = o.agent ? withLogin.find((x) => x.id === o.agent) : withLogin[0];
    if (!a) {
      throw new Error(
        o.agent
          ? `pod ${o.pod} has no agent ${o.agent} with a sign-in`
          : `no agent in pod ${o.pod} has a sign-in`,
      );
    }
    await signInHere(c, { machine: p.machine, agent: a.id, pod: o.pod, label: a.login?.label });
    return;
  }
  if (!o.machine) {
    const rows = machines.flatMap((m) =>
      (m.logins ?? []).map((l) => [
        m.name.replace(/^m-/, ""),
        `${l.label} (${l.agent})`,
        LOGIN_STATE_TEXT[l.state],
        l.pods.length ? l.pods.map((p) => p.id).join(", ") : "-",
      ]),
    );
    if (rows.length === 0) {
      console.log("No agents to sign in to (none of Panem's agents has a sign-in).");
      return;
    }
    console.log(table([["MACHINE", "AGENT", "SIGN-IN", "RUNNING PODS"], ...rows]));
    console.log(
      "\nSign in with: panem agent-login <machine> [agent]   (or Machines → Sign in in the web UI)",
    );
    return;
  }
  const name = o.machine.startsWith("m-") ? o.machine : `m-${o.machine}`;
  const m = machines.find((x) => x.name === name);
  if (!m) throw new Error(`machine ${o.machine} not registered (see: panem machine ls)`);
  const logins = m.logins ?? [];
  const login = o.agent
    ? logins.find((l) => l.agent === o.agent)
    : (logins.find((l) => l.state === "needs-sign-in") ?? logins[0]);
  if (!login) {
    throw new Error(
      o.agent
        ? `no agent ${o.agent} with a sign-in on ${o.machine}; see: panem agent-login`
        : `no agent with a sign-in on ${o.machine}`,
    );
  }
  const pods = await c.call<Pod[]>("GET", "/api/pods");
  const pod = pickLoginPod(name, login.agent, pods);
  if (!pod) {
    throw new Error(
      `no running pod on ${o.machine} has ${login.label}; summon one, then sign in from it`,
    );
  }
  await signInHere(c, { machine: name, agent: login.agent, pod, label: login.loginLabel });
}

const agentLoginCmd = defineCommand({
  meta: {
    name: "agent-login",
    description:
      "Sign an agent in on a machine (one sign-in serves every pod there). With no machine, list the agents you can sign in to",
  },
  args: {
    machine: { type: "positional", required: false, description: "Machine (default: list)" },
    agent: {
      type: "positional",
      required: false,
      description: "Agent id (default: the first one waiting for a sign-in)",
    },
    pod: {
      type: "string",
      description: "Sign in this pod only (one that can't use the machine's sign-in)",
    },
  },
  run: ({ args }) =>
    agentLogin({
      machine: args.machine as string | undefined,
      agent: args.agent as string | undefined,
      pod: args.pod as string | undefined,
    }),
});

/**
 * Run an agent's own sign-in in this terminal, in a pod (over DevPod, so on the controller), then
 * let the controller restart the agent wherever it waits for a sign-in on that machine. The
 * same flow as the web UI's Sign in, for any agent with a "login" block.
 */
async function signInHere(
  c: Awaited<ReturnType<typeof client>>,
  t: { machine: string; agent: string; pod: string; label?: string },
) {
  const cfg = await loadConfig().catch(() => undefined);
  if (!cfg) {
    throw new Error(
      "run this on the controller (it uses DevPod there): ssh -t <controller> panem agent-login …, or use Sign in on the Machines page of the web UI",
    );
  }
  console.log(
    `${t.label ?? "Sign in"} (${t.agent}) on ${t.machine.replace(/^m-/, "")}, in ${t.pod}. Follow the steps below; the sign-in is yours, Panem never sees it.\n`,
  );
  const proc = Bun.spawn(
    [
      cfg.devpodPath,
      "ssh",
      t.pod,
      "--start-services=false",
      "--command",
      `/usr/local/share/panem/agent-login.sh ${t.agent}`,
    ],
    { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, SSH_AUTH_SOCK: "" } },
  );
  if ((await proc.exited) !== 0) throw new Error("sign-in didn't finish");
  const r = await c.call<{ restarted: string[] }>(
    "POST",
    `/api/machines/${encodeURIComponent(t.machine)}/logins/${encodeURIComponent(t.agent)}/done`,
    { pod: t.pod },
  );
  console.log(`Signed in. ${t.agent} restarted in: ${r.restarted.join(", ")}`);
}

const podId = { id: { type: "positional", required: true } } as const;

const pod = defineCommand({
  meta: { name: "pod", description: "Manage pods" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List pods across machines" },
      async run() {
        const ps = await (await client()).call<Pod[]>("GET", "/api/pods");
        console.log(
          table([
            ["ID", "STATE", "MACHINE", "TEMPLATE", "AGENTS", "REFS", "PORTS"],
            ...ps.map((p) => [
              p.id,
              p.state,
              `${p.machine}${p.machineStatus === "offline" ? " (offline)" : ""}`,
              p.template,
              (p.agents ?? []).map((a) => a.id).join(",") || "-",
              p.repos.map((r) => `${r.name}@${r.ref}`).join(" "),
              p.services
                .map((x) =>
                  x.url
                    ? `${x.podPort}->${x.url.replace(/^http:\/\//, "")}`
                    : `${x.podPort}${x.exposed ? "(pending)" : "(off)"}`,
                )
                .join(" "),
            ]),
          ]),
        );
      },
    }),
    summon: defineCommand({
      meta: { name: "summon", description: "Create a pod from a template" },
      args: {
        template: { type: "positional", required: true },
        machine: { type: "string", alias: "m", required: true },
        ref: { type: "string", description: "repo=ref overrides, comma separated" },
      },
      async run({ args }) {
        const ref = typeof args.ref === "string" ? args.ref : "";
        const refs = ref
          ? Object.fromEntries(ref.split(",").map((kv) => kv.split("=", 2) as [string, string]))
          : undefined;
        const m = String(args.machine);
        const machine = m.startsWith("m-") ? m : `m-${m}`;
        const p = await (await client()).call<Pod>("POST", "/api/pods", {
          template: args.template,
          machine,
          refs,
        });
        console.log(`summoning ${p.id} on ${p.machine}`);
      },
    }),
    stop: defineCommand({
      meta: { name: "stop", description: "Stop a pod (keeps its disk)" },
      args: podId,
      async run({ args }) {
        await (await client()).call("POST", `/api/pods/${args.id}/stop`);
        console.log(`stopping ${args.id}`);
      },
    }),
    start: defineCommand({
      meta: { name: "start", description: "Start a stopped pod" },
      args: podId,
      async run({ args }) {
        await (await client()).call("POST", `/api/pods/${args.id}/start`);
        console.log(`starting ${args.id}`);
      },
    }),
    login: defineCommand({
      meta: { name: "login", description: "Same as `panem agent-login --pod <pod> [agent]`" },
      args: { ...podId, agent: { type: "positional", required: false } },
      run: ({ args }) =>
        agentLogin({ pod: String(args.id), agent: args.agent as string | undefined }),
    }),
    rm: defineCommand({
      meta: {
        name: "rm",
        description: "Run before-destroy hooks, save agent memory, then delete a pod",
      },
      args: {
        ...podId,
        memory: {
          type: "boolean",
          default: true,
          description: "Save agent memory; --no-memory skips it (hooks still run)",
        },
        force: {
          type: "boolean",
          description: "Skip hooks and memory (machine offline or a hook keeps failing)",
        },
      },
      async run({ args }) {
        const noMemory = args.memory === false;
        const q = args.force ? "?force=true" : noMemory ? "?memory=false" : "";
        await (await client()).call("DELETE", `/api/pods/${args.id}${q}`);
        console.log(
          args.force
            ? `deleted ${args.id}`
            : noMemory
              ? `deleting ${args.id} without saving memory`
              : `saving memory and deleting ${args.id}`,
        );
      },
    }),
    expose: defineCommand({
      meta: { name: "expose", description: "Publish a pod port on its machine" },
      args: { ...podId, port: { type: "positional", required: true } },
      async run({ args }) {
        await setExposure(String(args.id), String(args.port), true);
      },
    }),
    unexpose: defineCommand({
      meta: { name: "unexpose", description: "Stop publishing a pod port" },
      args: { ...podId, port: { type: "positional", required: true } },
      async run({ args }) {
        await setExposure(String(args.id), String(args.port), false);
      },
    }),
    "retry-export": defineCommand({
      meta: { name: "retry-export", description: "Retry a failed export" },
      args: podId,
      async run({ args }) {
        await (await client()).call("POST", `/api/pods/${args.id}/retry-export`);
        console.log(`retrying export of ${args.id}`);
      },
    }),
  },
});

async function setExposure(id: string, port: string, exposed: boolean) {
  const p = await (await client()).call<Pod>("PUT", `/api/pods/${id}/ports/${port}`, { exposed });
  const svc = p.services.find((x) => String(x.podPort) === port);
  console.log(
    exposed
      ? svc?.url
        ? `${id}:${port} -> ${svc.url}`
        : `${id}:${port} switched on (publishing when the pod is running)`
      : `${id}:${port} switched off`,
  );
}

const rediscover = defineCommand({
  meta: { name: "rediscover", description: "Rebuild pod metadata from the pods themselves" },
  async run() {
    const r = await (await client()).call<{ found: string[]; failed: string[] }>(
      "POST",
      "/api/rediscover",
    );
    console.log(`found: ${r.found.join(", ") || "none"}`);
    if (r.failed.length) console.log(`could not read (start them first): ${r.failed.join(", ")}`);
  },
});

export const main = defineCommand({
  meta: { name: "panem", version: VERSION, description: "Agent pods on your own machines" },
  subCommands: {
    serve,
    init,
    workspace,
    token,
    env,
    machine,
    pod,
    "agent-login": agentLoginCmd,
    rediscover,
  },
});

if (import.meta.main) runMain(main);
