import type { Template, TemplateRepo } from "./schemas";

/** Code repos live here; identical on every machine so Claude's project folder names match. */
export const CODE_ROOT = "/codebase";
/** The code root before the /codebase rename. Export still recognises its memory folders. */
export const LEGACY_CODE_ROOT = "/workspace";

/** Panem's per-pod files inside a pod (pod.json, logs), and where they were before the rename. */
export const POD_STATE_DIR = "~/.panem";
export const LEGACY_POD_STATE_DIR = "/workspace/.panem";

/** Shell snippet printing the pod's pod.json, from wherever this pod's Feature version wrote it. */
export const READ_POD_JSON = `cat "$HOME/.panem/pod.json" 2>/dev/null || cat ${LEGACY_POD_STATE_DIR}/pod.json`;

/** Claude Code's per-project folder name for a path: every "/" (and ".") becomes "-". */
export function claudeProjectDir(path: string): string {
  return path.replace(/[^A-Za-z0-9-]/g, "-");
}

export function repoPath(repo: string, root = CODE_ROOT): string {
  return `${root}/${repo}`;
}

export function machineProviderName(host: string): string {
  const short = host
    .split(".")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `m-${short}`;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function shortId(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function newPodId(template: string): string {
  // DevPod ids are limited to 48 chars.
  return `${template.slice(0, 40)}-${shortId()}`;
}

export function primaryRepo(t: Template): TemplateRepo {
  return t.repos.find((r) => r.primary) ?? t.repos[0]!;
}

/** Repos with ref overrides applied, primary repo first. */
export function resolveRefs(t: Template, overrides: Record<string, string> = {}) {
  const unknown = Object.keys(overrides).filter((k) => !t.repos.some((r) => r.name === k));
  if (unknown.length) throw new Error(`unknown repo(s) in refs: ${unknown.join(", ")}`);
  const primary = primaryRepo(t);
  const ordered = [primary, ...t.repos.filter((r) => r !== primary)];
  return ordered.map((r) => ({ name: r.name, url: r.url, ref: overrides[r.name] ?? r.ref }));
}

export function devcontainerPathFor(t: Template): string {
  return t.devcontainerPath ?? `templates/${t.name}/.devcontainer/devcontainer.json`;
}

/** Port the in-pod relay listens on (inside the container; never published). */
export const RELAY_PORT = 7699;

/** Version of this Panem build; the controller expects forwarders to match it. */
export const PANEM_VERSION = "0.2.0";

export const FORWARDER_IMAGE = "ghcr.io/fdhani/panem/forwarder";
export const FORWARDER_CONTAINER = "panem-forwarder";
