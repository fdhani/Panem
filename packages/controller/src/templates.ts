import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Template, devcontainerPathFor } from "@panem/core";
import type { WorkspaceRepo } from "./git";

export interface TemplateLoadResult {
  templates: Template[];
  errors: { name: string; error: string }[];
}

export class Templates {
  constructor(
    private readonly repo: WorkspaceRepo,
    private readonly ttlMs = 30_000,
  ) {}

  async list(): Promise<TemplateLoadResult> {
    await this.repo.sync(this.ttlMs);
    return this.repo.lock.run(() => loadTemplates(this.repo.dir));
  }

  async get(name: string): Promise<Template | undefined> {
    return (await this.list()).templates.find((t) => t.name === name);
  }
}

export async function loadTemplates(root: string): Promise<TemplateLoadResult> {
  const dir = join(root, "templates");
  const out: TemplateLoadResult = { templates: [], errors: [] };
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(join(dir, name, "template.json"), "utf8"));
      const t = Template.parse({ name, ...raw });
      if (t.name !== name) throw new Error(`name "${t.name}" must match folder "${name}"`);
      out.templates.push({ ...t, devcontainerPath: devcontainerPathFor(t) });
    } catch (e) {
      out.errors.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
