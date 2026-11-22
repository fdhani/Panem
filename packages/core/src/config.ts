import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Config } from "./schemas";

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

export async function saveConfig(cfg: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(Config.parse(cfg), null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  const { rename } = await import("node:fs/promises");
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
