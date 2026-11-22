import {
  type Config,
  type CredentialInfo,
  DEFAULT_TEMPLATE_ENV,
  type Template,
  agentCredentials,
  loadConfig,
  removeCredential,
  setCredential,
} from "@panem/core";

/**
 * Agent credentials, kept in the controller's config file so the CLI (`panem env`) and the web
 * UI edit the same values. Without a config file (tests, mock) they live in memory.
 */
export class Credentials {
  private memory: Record<string, string>;
  private memoryUpdated: Record<string, string> = {};

  constructor(
    private readonly config: Config,
    private readonly path?: string,
  ) {
    this.memory = agentCredentials(config);
  }

  /** Every value, read fresh, for handing to new pods. */
  async all(): Promise<Record<string, string>> {
    if (!this.path) return { ...this.memory };
    return agentCredentials(await loadConfig(this.path).catch(() => this.config));
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.path) {
      this.memory = { ...this.memory, [name]: value };
      this.memoryUpdated = { ...this.memoryUpdated, [name]: new Date().toISOString() };
      return;
    }
    await setCredential(name, value, this.path);
  }

  async remove(name: string): Promise<void> {
    if (!this.path) {
      const { [name]: _, ...rest } = this.memory;
      const { [name]: __, ...times } = this.memoryUpdated;
      this.memory = rest;
      this.memoryUpdated = times;
      return;
    }
    await removeCredential(name, this.path);
  }

  /** Names that are set or that a template asks for, sorted, without values. */
  private async updatedTimes(): Promise<Record<string, string>> {
    if (!this.path) return this.memoryUpdated;
    return (await loadConfig(this.path).catch(() => this.config)).agentEnvUpdated;
  }

  async describe(templates: Template[]): Promise<CredentialInfo[]> {
    const set = new Set(Object.keys(await this.all()));
    const updated = await this.updatedTimes();
    const usedBy = new Map<string, string[]>();
    for (const t of templates) {
      for (const n of t.env ?? DEFAULT_TEMPLATE_ENV)
        usedBy.set(n, [...(usedBy.get(n) ?? []), t.name]);
    }
    return [...new Set([...set, ...usedBy.keys()])].sort().map((name) => ({
      name,
      set: set.has(name),
      ...(set.has(name) && updated[name] ? { updatedAt: updated[name] } : {}),
      usedBy: usedBy.get(name) ?? [],
    }));
  }
}
