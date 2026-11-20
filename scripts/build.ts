// Builds the single `panem` binary with the web UI embedded.
// Usage: bun run build [--target=bun-linux-x64|bun-linux-arm64|bun-darwin-arm64|...]
import { readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "packages/web/dist");
const gen = join(root, "packages/controller/src/ui-assets.gen.ts");
const stub = await Bun.file(gen).text();
const target = process.argv.find((a) => a.startsWith("--target="))?.slice(9);
const outfile = join(root, "dist", target ? `panem-${target.replace(/^bun-/, "")}` : "panem");

const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((f) => f.isFile())
  .map((f) => join(f.parentPath, f.name));
if (!files.some((f) => f.endsWith("index.html"))) throw new Error("run `bun run build:web` first");

const lines = files.map(
  (f, i) =>
    `import f${i} from ${JSON.stringify(relative(join(gen, ".."), f))} with { type: "file" };`,
);
const map = files.map((f, i) => `  ${JSON.stringify(`/${relative(dist, f)}`)}: f${i},`);
await writeFile(
  gen,
  `${lines.join("\n")}\n\nexport const embedded: Record<string, string> = {\n${map.join("\n")}\n};\n`,
);
try {
  const args = [
    "build",
    "--compile",
    "--minify",
    join(root, "packages/cli/src/main.ts"),
    "--outfile",
    outfile,
  ];
  if (target) args.push(`--target=${target}`);
  const p = Bun.spawnSync(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
  console.log(`built ${relative(root, outfile)} with ${files.length} UI files embedded`);
} finally {
  await writeFile(gen, stub);
}
