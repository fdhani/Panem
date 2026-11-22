#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Machine, Pod } from "@panem/core";
import {
  Config,
  EnvName,
  PANEM_VERSION,
  agentCredentials,
  configPath,
  loadConfig,
  removeCredential,
  saveConfig,
  setCredential,
} from "@panem/core";
import { defineCommand, runMain } from "citty";
import { client, table } from "./client";

export const VERSION = PANEM_VERSION;

const secret = () => randomBytes(24).toString("base64url");

const serve = defineCommand({
  meta: { name: "serve", description: "Run the controller (API + web UI)" },
  async run() {
    const { serve } = await import("@panem/controller");
    let cfg = await loadConfig();
    // Configs from before port forwarding lack its secrets: add them once.
    if (!cfg.relaySecret || !cfg.forwarderToken) {
      cfg = {
        ...cfg,
        relaySecret: cfg.relaySecret ?? secret(),
        forwarderToken: cfg.forwarderToken ?? secret(),
      };
      await saveConfig(cfg);
      console.log("[panem] added port-forwarding secrets to the config");
    }
    await serve(cfg, configPath());
    await new Promise(() => {});
  },
});

const init = defineCommand({
  meta: { name: "init", description: "Write ~/.config/panem/config.json" },
  args: {
    "workspace-repo": {
      type: "string",
      description: "Git URL of your workspace repo",
      required: true,
    },
    branch: { type: "string", default: "main" },
    port: { type: "string", default: "7420" },
    "claude-token": {
      type: "string",
      description: "Token from `claude setup-token` (or set CLAUDE_CODE_OAUTH_TOKEN)",
    },
    devpod: { type: "string", default: "devpod", description: "Path to the devpod binary" },
    force: { type: "boolean", description: "Overwrite an existing config" },
  },
  async run({ args }) {
    const path = configPath();
    if (existsSync(path) && !args.force) {
      throw new Error(`${path} exists; pass --force to overwrite`);
    }
    const cfg = Config.parse({
      workspaceRepoUrl: args["workspace-repo"],
      workspaceBranch: args.branch,
      apiToken: secret(),
      relaySecret: secret(),
      forwarderToken: secret(),
      claudeOauthToken: args["claude-token"] ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
      port: Number(args.port),
      devpodPath: args.devpod,
    });
    await saveConfig(cfg, path);
    console.log(`wrote ${path}`);
    console.log(`API token (paste into the web UI settings): ${cfg.apiToken}`);
    if (!cfg.claudeOauthToken) {
      console.log("No Claude token set: pods will need a manual `claude /login`.");
      console.log("Run `claude setup-token`, then `panem init --force --claude-token ...`.");
    }
  },
});

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
  subCommands: { serve, init, token, env, machine, pod, rediscover },
});

if (import.meta.main) runMain(main);
