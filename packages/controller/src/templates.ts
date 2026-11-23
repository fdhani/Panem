import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Template, devcontainerPathFor, resolveSync } from "@panem/core";
import type { Workspace } from "./workspace";

export interface TemplateLoadResult {
  templates: Template[];
  errors: { name: string; error: string }[];
  /** Templates that load but probably won't build as they are (e.g. an unpublished Feature). */
  warnings: { name: string; warning: string }[];
  /** Parsed panem.json (sync sources and rules), or undefined when there is none. */
  panem?: unknown;
}

export class Templates {
  constructor(private readonly workspace: Workspace) {}

  /** Templates in the workspace folder (none while no workspace is set). */
  async list(): Promise<TemplateLoadResult> {
    if (!(await this.workspace.current())) return { templates: [], errors: [], warnings: [] };
    return loadTemplates(await this.workspace.dir());
  }

  async get(name: string): Promise<Template | undefined> {
    return (await this.list()).templates.find((t) => t.name === name);
  }

  /** A template plus the panem.json it should be resolved with. */
  async getWithConfig(name: string): Promise<{ template?: Template; panem?: unknown }> {
    const r = await this.list();
    return { template: r.templates.find((t) => t.name === name), panem: r.panem };
  }
}

export async function loadTemplates(root: string): Promise<TemplateLoadResult> {
  const dir = join(root, "templates");
  const out: TemplateLoadResult = { templates: [], errors: [], warnings: [] };
  let panemError: string | undefined;
  try {
    out.panem = JSON.parse(await readFile(join(root, "panem.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      panemError = `panem.json: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
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
      if (panemError) throw new Error(panemError);
      // Sync rules are checked here too, so a bad rule shows up before anyone summons.
      resolveSync(out.panem, t);
      out.templates.push({ ...t, devcontainerPath: devcontainerPathFor(t) });
      const dc = await readFile(join(root, devcontainerPathFor(t)), "utf8").catch(() => "");
      const old = dc.match(/ghcr\.io\/fdhani\/panem\/([a-z-]+)(:[^"]*)?/);
      if (old) {
        out.warnings.push({
          name,
          warning: `devcontainer.json uses ${old[0]}, which needs a published Panem release. Use "./panem-features/${old[1]}" instead: Panem puts its Features there at each summon.`,
        });
      }
    } catch (e) {
      out.errors.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
