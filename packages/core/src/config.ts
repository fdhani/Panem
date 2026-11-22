import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Config, EnvName } from "./schemas";

export function configPath(): string {
  return process.env.PANEM_CONFIG ?? join(homedir(), ".config", "panem", "config.json");
}

export function dataDir(): string {
  return process.env.PANEM_DATA ?? join(homedir(), ".local", "share", "panem");
}

export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`config not found at ${path}; run \`panem init\``);
  }
  return Config.parse(JSON.parse(raw));
}

/** Write the config (0600), atomically: a temp file renamed over the old one. */
export async function saveConfig(cfg: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(Config.parse(cfg), null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * Read, change and write the config while holding `<config>.lock`, so the controller (web UI)
 * and the CLI never overwrite each other's changes. A lock older than 10s is taken as stale.
 */
export async function updateConfig(
  change: (cfg: Config) => Config,
  path = configPath(),
): Promise<Config> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > 10_000) await rm(lock, { force: true });
      else if (i > 200) throw new Error(`config is locked (${lock})`);
      else await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    const next = change(await loadConfig(path));
    await saveConfig(next, path);
    return next;
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Bring an older config up to date, under the lock, writing only if something changed:
 * - port forwarding's secrets (configs from before it) are generated;
 * - the old `claudeOauthToken` setting moves into agentEnv (no updated time: it isn't known).
 * `secret` makes a new random secret (passed in so core stays free of crypto choices).
 */
export async function upgradeConfig(
  secret: () => string,
  path = configPath(),
): Promise<{ cfg: Config; notes: string[] }> {
  const notes: string[] = [];
  const needs = (c: Config) =>
    !c.relaySecret || !c.forwarderToken || c.claudeOauthToken !== undefined;
  if (!needs(await loadConfig(path))) return { cfg: await loadConfig(path), notes };
  const cfg = await updateConfig((c) => {
    let next = c;
    if (!c.relaySecret || !c.forwarderToken) {
      next = {
        ...next,
        relaySecret: c.relaySecret ?? secret(),
        forwarderToken: c.forwarderToken ?? secret(),
      };
      notes.push("added port-forwarding secrets to the config");
    }
    if (c.claudeOauthToken !== undefined) {
      const { claudeOauthToken, ...rest } = next;
      next = {
        ...rest,
        agentEnv: {
          ...(claudeOauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken } : {}),
          ...next.agentEnv, // a value already in agentEnv wins, as it does when reading
        },
      };
      notes.push("moved claudeOauthToken into agentEnv (CLAUDE_CODE_OAUTH_TOKEN)");
    }
    return next;
  }, path);
  return { cfg, notes };
}

/** Set an agent credential (by env var name) in the config. */
export function setCredential(name: string, value: string, path = configPath()) {
  const n = EnvName.parse(name);
  if (!value) throw new Error("empty value");
  return updateConfig(
    (cfg) => ({
      ...cfg,
      agentEnv: { ...cfg.agentEnv, [n]: value },
      agentEnvUpdated: { ...cfg.agentEnvUpdated, [n]: new Date().toISOString() },
    }),
    path,
  );
}

/** Remove an agent credential, including the older claudeOauthToken setting for the Claude one. */
export function removeCredential(name: string, path = configPath()) {
  const n = EnvName.parse(name);
  return updateConfig((cfg) => {
    const { [n]: _, ...agentEnv } = cfg.agentEnv;
    const { [n]: __, ...agentEnvUpdated } = cfg.agentEnvUpdated;
    return {
      ...cfg,
      ...(n === "CLAUDE_CODE_OAUTH_TOKEN" ? { claudeOauthToken: undefined } : {}),
      agentEnv,
      agentEnvUpdated,
    };
  }, path);
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** All agent credentials: agentEnv, plus the older claudeOauthToken setting (agentEnv wins). */
export function agentCredentials(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg.claudeOauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = cfg.claudeOauthToken;
  return { ...out, ...cfg.agentEnv };
}
