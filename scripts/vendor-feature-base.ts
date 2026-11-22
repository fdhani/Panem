// Copies the Panem pod base (features/src/panem) into every agent Feature as panem-base/, so
// each agent Feature can install the base itself when a template lists only the agent.
//   bun scripts/vendor-feature-base.ts           write the copies
//   bun scripts/vendor-feature-base.ts --check   exit 1 if any copy is out of date
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, relative } from "node:path";

const src = join(import.meta.dir, "../features/src");
const base = join(src, "panem");
const PARTS = ["install.sh", "VERSION", "scripts"];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

export function agentFeatures(): string[] {
  return readdirSync(src).filter((d) => existsSync(join(src, d, "agent")));
}

/** Differences between the base and an agent's copy, as relative paths. */
export function staleFiles(agent: string): string[] {
  const copy = join(src, agent, "panem-base");
  const want = PARTS.flatMap((p) =>
    p === "scripts" ? files(join(base, p)).map((f) => join(p, f)) : [p],
  );
  const have = files(copy);
  const out = new Set<string>();
  for (const f of want) {
    const a = join(base, f);
    const b = join(copy, f);
    if (!existsSync(b) || !readFileSync(a).equals(readFileSync(b))) out.add(f);
  }
  for (const f of have) if (!want.includes(f)) out.add(f);
  return [...out].sort();
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const agent of agentFeatures()) {
    const stale = staleFiles(agent);
    if (check) {
      if (stale.length) {
        bad++;
        console.error(`features/src/${agent}/panem-base is out of date: ${stale.join(", ")}`);
      }
      continue;
    }
    const copy = join(src, agent, "panem-base");
    rmSync(copy, { recursive: true, force: true });
    for (const p of PARTS) await cp(join(base, p), join(copy, p), { recursive: true });
    console.log(`vendored the pod base into features/src/${agent}/panem-base`);
  }
  if (bad) {
    console.error("run: bun scripts/vendor-feature-base.ts");
    process.exit(1);
  }
}
