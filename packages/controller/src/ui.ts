import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { embedded } from "./ui-assets.gen";

/** UI assets: embedded in the compiled binary, else read from a dist folder on disk. */
export async function loadUi(dir?: string): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  if (Object.keys(embedded).length > 0) {
    for (const [path, file] of Object.entries(embedded)) out.set(path, Bun.file(file));
    return out;
  }
  const root = dir ?? process.env.PANEM_UI_DIR ?? join(import.meta.dir, "../../web/dist");
  if (!existsSync(root)) return out;
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const f of files) {
    if (!f.isFile()) continue;
    const abs = join(f.parentPath, f.name);
    out.set(`/${relative(root, abs)}`, Bun.file(abs));
  }
  return out;
}
