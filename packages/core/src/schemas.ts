import { z } from "zod";
import { GitRef } from "./refs";
import { ResolvedSync, SyncEntry } from "./sync";

export { GitRef } from "./refs";

/** Lowercase name usable in DevPod ids, provider names, and paths. */
export const Slug = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, and dashes only");

/** An environment variable name for agent credentials. PANEM_* names are Panem's own. */
export const EnvName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "env names: uppercase letters, digits and _")
  .refine((n) => !n.startsWith("PANEM_"), "PANEM_* names are reserved");

/** Credentials a template gets when it doesn't list `env`. */
export const DEFAULT_TEMPLATE_ENV = ["CLAUDE_CODE_OAUTH_TOKEN"];

/** What the API says about one agent credential. Never its value. */
export interface CredentialInfo {
  name: string;
  set: boolean;
  /** When the value was last set, if known. */
  updatedAt?: string;
  /** Templates whose pods get it (their `env`, or the Claude token by default). */
  usedBy: string[];
}

/** Commands a template runs in its pods at lifecycle points. */
export const TemplateHooks = z
  .object({
    /**
     * Runs in the pod (bash, from /codebase) before it's deleted, after agents' own hooks and
     * before agent memory is saved. E.g. push overlay work to its repo. Failing keeps the pod.
     */
    beforeDestroy: z.string().min(1).optional(),
  })
  .strict();
export type TemplateHooks = z.infer<typeof TemplateHooks>;

/** An agent installed in a pod (from ~/.panem/agents.json, written by the Panem base). */
/** How an agent reports itself (agent_status in the pod; see features/README.md). */
export const AgentState = z.enum(["running", "needs-login", "stopped", "error"]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentInfo = z.object({
  id: z.string(),
  label: z.string().default(""),
  connect: z.array(z.object({ label: z.string(), url: z.string().url() })).default([]),
  /** The agent's own log, shown as it is on its page ("~/…" in the pod). */
  log: z
    .string()
    .regex(/^~\/[A-Za-z0-9._/-]+$/)
    .refine((p) => !p.includes(".."), "no ..")
    .optional(),
  /**
   * The agent's own sign-in (run from the UI or `panem agent-login`); its
   * files are shared per machine. `shared`/`reason`: whether this pod uses the machine's
   * sign-in, and why not (from ~/.panem/agents/<id>.login.json).
   */
  login: z
    .object({
      label: z.string().default("Sign in"),
      command: z.string().optional(),
      share: z.array(z.string()).optional(),
      shared: z.boolean().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  /** Last reported state (from the agent's start hook). */
  status: z
    .object({ state: AgentState, message: z.string().default(""), at: z.string().optional() })
    .optional(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

/** What pods from before agents were pluggable have: Claude Code with Remote Control. */
export const LEGACY_AGENTS: AgentInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    connect: [{ label: "Open in Claude", url: "https://claude.ai/code" }],
  },
];

export const TemplateRepo = z.object({
  /** Folder name under /codebase. */
  name: Slug,
  url: z.string().min(1),
  ref: GitRef.default("main"),
  primary: z.boolean().optional(),
});
export type TemplateRepo = z.infer<typeof TemplateRepo>;

export const PortNumber = z.coerce.number().int().min(1).max(65535);

/** Ports a template declares: pod port -> display name. Declared ports get the first slots. */
export const PortNames = z.record(z.string().regex(/^\d{1,5}$/), z.string().min(1).max(40));

/** HTTPS access to one git host: a Panem credential holding a token, used by a git helper. */
export const GitHostAuth = z
  .object({
    /** Name of the credential (`panem env set NAME`) holding the token. */
    token: EnvName,
    /** Username sent with the token (default: x-access-token on github.com, else oauth2). */
    username: z.string().min(1).max(100).optional(),
  })
  .strict();
export type GitHostAuth = z.infer<typeof GitHostAuth>;

export const Template = z.object({
  name: Slug,
  description: z.string().default(""),
  repos: z.array(TemplateRepo).min(1),
  ports: PortNames.optional(),
  /** Ports never exposed (e.g. debuggers, internal agents). */
  ignorePorts: z.array(PortNumber).optional(),
  /** Replaces panem.json's `sync` (rules and presets) for pods of this template. */
  sync: z.array(SyncEntry).optional(),
  /**
   * Agent credentials (names of the controller's `agentEnv`) this template's pods receive.
   * Absent: just the Claude token, as before agents were pluggable.
   */
  env: z.array(EnvName).optional(),
  hooks: TemplateHooks.optional(),
  /**
   * HTTPS token access per git host, e.g. {"gitlab.com": {"token": "GITLAB_TOKEN"}}. SSH repos
   * need nothing here: keys come from the controller's ~/.ssh/config.
   */
  git: z.record(z.string().regex(/^[A-Za-z0-9.-]+$/, "a host name"), GitHostAuth).optional(),
  /** Added to panem.json's `exclude` for pods of this template. */
  syncExclude: z.array(z.string().min(1)).optional(),
  /** Path inside the workspace folder, relative to it. Defaults to the template's .devcontainer folder. */
  devcontainerPath: z.string().min(1).optional(),
});
export type Template = z.infer<typeof Template>;

export const MachineStatus = z.enum(["online", "offline", "unknown"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

export const ForwarderStatus = z.object({
  status: z.enum(["running", "missing", "outdated", "error", "disabled"]),
  version: z.string().optional(),
  /** Address pod ports are published on (the machine's Tailscale IP). */
  address: z.string().optional(),
  error: z.string().optional(),
});
export type ForwarderStatus = z.infer<typeof ForwarderStatus>;

/**
 * One agent's sign-in on a machine, worked out from its pods (any agent whose agent.json has a
 * "login" block): signed-in when a pod there runs the agent with the machine's sign-in,
 * needs-sign-in when pods wait for one, no-pods when no running pod has the agent, unknown
 * otherwise (e.g. the agent failed for another reason: its page says why).
 */
export const MachineLogin = z.object({
  agent: z.string(),
  label: z.string(),
  loginLabel: z.string(),
  state: z.enum(["signed-in", "needs-sign-in", "no-pods", "unknown"]),
  pods: z.array(
    z.object({
      id: z.string(),
      state: AgentState.optional(),
      shared: z.boolean().optional(),
      reason: z.string().optional(),
    }),
  ),
});
export type MachineLogin = z.infer<typeof MachineLogin>;

export const Machine = z.object({
  /** DevPod provider name, e.g. m-vps. */
  name: z.string(),
  /** Tailscale hostname. */
  host: z.string(),
  user: z.string().optional(),
  status: MachineStatus,
  forwarder: ForwarderStatus.optional(),
  /** Agents' sign-ins on this machine. */
  logins: z.array(MachineLogin).optional(),
});
export type Machine = z.infer<typeof Machine>;

export const PodState = z.enum([
  "creating",
  "running",
  "stopping",
  "stopped",
  "starting",
  "exporting",
  "deleting",
  "error",
]);
export type PodState = z.infer<typeof PodState>;

/** Metadata the controller attaches to a pod. Also written inside the pod as pod.json. */
export const PodMeta = z.object({
  id: z.string(),
  template: z.string(),
  machine: z.string(),
  /** Primary repo first. */
  repos: z.array(z.object({ name: z.string(), url: z.string(), ref: z.string() })),
  /** Pods from when the workspace was a git repo: the commit they were given. Unused now. */
  workspaceSha: z.string().optional(),
  createdAt: z.string(),
  ports: PortNames.optional(),
  ignorePorts: z.array(PortNumber).optional(),
  /**
   * Ports switched on (published on the machine). Starts as the template's named ports;
   * everything else stays closed until switched on.
   */
  exposePorts: z.array(PortNumber).optional(),
  /**
   * The sync rules and sources resolved at summon, plus what was sent (merge bases).
   * Export uses this, never the workspace's current panem.json. Absent on older pods.
   */
  sync: ResolvedSync.optional(),
  /** The template's hooks as they were at summon (delete runs these, not today's template). */
  hooks: TemplateHooks.optional(),
  /** Agents installed in the pod, read after its start hook. Absent on older pods. */
  agents: z.array(AgentInfo).optional(),
});
export type PodMeta = z.infer<typeof PodMeta>;

/** A port inside a pod, as seen by its machine's forwarder. */
export const PodServicePort = z.object({
  podPort: z.number().int(),
  name: z.string().optional(),
  /** Something is listening on podPort right now. */
  live: z.boolean(),
  /** Switched on. hostPort/url are set once the forwarder has published it. */
  exposed: z.boolean(),
  hostPort: z.number().int().optional(),
  url: z.string().optional(),
});
export type PodServicePort = z.infer<typeof PodServicePort>;

export const Pod = PodMeta.extend({
  state: PodState,
  error: z.string().optional(),
  /** The last lines of output from the step that failed (e.g. devpod up), when there are any. */
  errorLog: z.array(z.string()).optional(),
  machineStatus: MachineStatus,
  services: z.array(PodServicePort).default([]),
  /** Slot 0: an index page listing the pod's services. */
  indexUrl: z.string().optional(),
});
export type Pod = z.infer<typeof Pod>;

export const JobStatus = z.enum(["pending", "running", "failed", "done"]);
export const Job = z.object({
  id: z.string(),
  kind: z.literal("export-delete"),
  podId: z.string(),
  status: JobStatus,
  attempts: z.number().int().default(0),
  /** Save agent memory before deleting. Before-destroy hooks run either way. */
  saveMemory: z.boolean().default(true),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof Job>;

export const Config = z.object({
  /**
   * The workspace folder on the controller (absolute): templates, panem.json, files copied
   * into pods, and saved agent memory. Set by `panem workspace init`.
   */
  workspaceDir: z.string().optional(),
  /** Older configs: the workspace was a git repo. Only read to explain how to move it. */
  workspaceRepoUrl: z.string().optional(),
  workspaceBranch: z.string().optional(),
  apiToken: z.string().min(16),
  /** Kept for older configs: same as agentEnv.CLAUDE_CODE_OAUTH_TOKEN. */
  claudeOauthToken: z.string().optional(),
  /** Agent credentials, by env var name. Each template lists which ones its pods get. */
  agentEnv: z.record(EnvName, z.string().min(1)).default({}),
  /** When each agentEnv value was last set (ISO time). Values set before this was kept have none. */
  agentEnvUpdated: z.record(EnvName, z.string()).default({}),
  port: z.number().int().default(7420),
  devpodPath: z.string().default("devpod"),
  /** Extra listen addresses; the Tailscale IP is added automatically when found. */
  listen: z.array(z.string()).default(["127.0.0.1"]),
  /** Shared by pod relays and forwarders. Port forwarding is off without it. */
  relaySecret: z.string().min(16).optional(),
  /** Bearer token for each machine's forwarder control API. */
  forwarderToken: z.string().min(16).optional(),
  forwarder: z
    .object({
      image: z.string().optional(),
      portRange: z.tuple([PortNumber, PortNumber]).default([7600, 7699]),
      controlPort: PortNumber.default(7599),
      blockSize: z.number().int().min(2).max(100).default(10),
    })
    .default({}),
});
export type Config = z.infer<typeof Config>;

// ---- API DTOs ----

export const SummonRequest = z.object({
  template: Slug,
  machine: z.string().min(1),
  /** Optional per-repo ref overrides, keyed by repo name. */
  refs: z.record(GitRef).optional(),
});
export type SummonRequest = z.infer<typeof SummonRequest>;

export const AddMachineRequest = z.object({
  host: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9.-]+$/, "invalid hostname"),
  user: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]*$/, "invalid user")
    .optional(),
});
export type AddMachineRequest = z.infer<typeof AddMachineRequest>;

export const SetPortExposure = z.object({ exposed: z.boolean() });
export type SetPortExposure = z.infer<typeof SetPortExposure>;

export type ServerEvent =
  | { type: "pods"; pods: Pod[] }
  | { type: "machines"; machines: Machine[] }
  | { type: "jobs"; jobs: Job[] };

// ---- forwarder control API ----

export const ForwarderPodState = z.object({
  id: z.string(),
  /** First and last host port of the pod's block. The first is the index page. */
  block: z.tuple([z.number().int(), z.number().int()]),
  /** Running and its relay answers. */
  reachable: z.boolean(),
  /** Every port the forwarder knows for this pod: listening, named, or switched on. */
  ports: z.array(
    z.object({
      podPort: z.number().int(),
      name: z.string().optional(),
      /** Something is listening on it right now. */
      live: z.boolean(),
      /** Switched on: published on the machine (has a slot and host port). */
      exposed: z.boolean(),
      slot: z.number().int().optional(),
      hostPort: z.number().int().optional(),
    }),
  ),
  /** Exposed ports that didn't fit in the block. */
  unmapped: z.array(z.number().int()).default([]),
});
export type ForwarderPodState = z.infer<typeof ForwarderPodState>;

export const ForwarderState = z.object({
  version: z.string(),
  pods: z.array(ForwarderPodState),
  /** Pods that found no free block. */
  unplaced: z.array(z.string()).default([]),
});
export type ForwarderState = z.infer<typeof ForwarderState>;
