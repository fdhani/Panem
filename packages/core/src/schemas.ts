import { z } from "zod";

/** Lowercase name usable in DevPod ids, provider names, and paths. */
export const Slug = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, and dashes only");

/** Git ref: branch, tag, or commit. Rejects anything that could become a CLI flag. */
export const GitRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "invalid git ref")
  .refine((r) => !r.startsWith("-") && !r.includes(".."), "invalid git ref");

export const TemplateRepo = z.object({
  /** Folder name under /workspace. */
  name: Slug,
  url: z.string().min(1),
  ref: GitRef.default("main"),
  primary: z.boolean().optional(),
});
export type TemplateRepo = z.infer<typeof TemplateRepo>;

export const Template = z.object({
  name: Slug,
  description: z.string().default(""),
  repos: z.array(TemplateRepo).min(1),
  /** Path inside the workspace repo, relative to its root. */
  devcontainerPath: z.string().min(1),
});
export type Template = z.infer<typeof Template>;

export const MachineStatus = z.enum(["online", "offline", "unknown"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

export const Machine = z.object({
  /** DevPod provider name, e.g. m-vps. */
  name: z.string(),
  /** Tailscale hostname. */
  host: z.string(),
  user: z.string().optional(),
  status: MachineStatus,
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
  repos: z.array(z.object({ name: z.string(), url: z.string(), ref: z.string() })),
  /** Workspace repo commit the pod's context was taken from (base for 3-way export merge). */
  workspaceSha: z.string(),
  createdAt: z.string(),
});
export type PodMeta = z.infer<typeof PodMeta>;

export const Pod = PodMeta.extend({
  state: PodState,
  error: z.string().optional(),
  machineStatus: MachineStatus,
});
export type Pod = z.infer<typeof Pod>;

export const JobStatus = z.enum(["pending", "running", "failed", "done"]);
export const Job = z.object({
  id: z.string(),
  kind: z.literal("export-delete"),
  podId: z.string(),
  status: JobStatus,
  attempts: z.number().int().default(0),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof Job>;

export const Config = z.object({
  workspaceRepoUrl: z.string().min(1),
  /** Branch of the workspace repo used for templates and memory. */
  workspaceBranch: z.string().default("main"),
  apiToken: z.string().min(16),
  claudeOauthToken: z.string().optional(),
  port: z.number().int().default(7420),
  devpodPath: z.string().default("devpod"),
  /** Extra listen addresses; the Tailscale IP is added automatically when found. */
  listen: z.array(z.string()).default(["127.0.0.1"]),
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

export type ServerEvent =
  | { type: "pods"; pods: Pod[] }
  | { type: "machines"; machines: Machine[] }
  | { type: "jobs"; jobs: Job[] };
