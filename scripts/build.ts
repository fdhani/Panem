// Builds the single `panem` binary with the web UI, the forwarder bundle and the devcontainer
// Features embedded (what the controller delivers to machines itself: no registry).
// Usage: bun run build [--target=bun-linux-x64|bun-linux-arm64|bun-darwin-arm64|...]
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "packages/web/dist");
const gen = join(root, "packages/controller/src/ui-assets.gen.ts");
const stub = await Bun.file(gen).text();
const machineGen = join(root, "packages/controller/src/machine-assets.gen.ts");
const machineStub = await Bun.file(machineGen).text();
const staging = join(root, "dist/.machine-assets");
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
// What machines get: the forwarder as one JS file, and the Features' files.
const { buildForwarder, readFeatures } = await import(
  join(root, "packages/controller/src/machine-assets.ts")
);
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "features"), { recursive: true });
await writeFile(join(staging, "forwarder.js"), await buildForwarder());
const feats: { path: string; data: Uint8Array; exec: boolean }[] = await readFeatures(
  join(root, "features/src"),
);
for (const f of feats) {
  const p = join(staging, "features", f.path);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, f.data);
}
const rel = (p: string) => JSON.stringify(relative(join(machineGen, ".."), p));
await writeFile(
  machineGen,
  [
    `import fwd from ${rel(join(staging, "forwarder.js"))} with { type: "file" };`,
    ...feats.map(
      (f, i) =>
        `import ff${i} from ${rel(join(staging, "features", f.path))} with { type: "file" };`,
    ),
    "",
    "export const forwarderFile: string | undefined = fwd;",
    "export const featureFiles: Record<string, { file: string; exec: boolean }> = {",
    ...feats.map((f, i) => `  ${JSON.stringify(f.path)}: { file: ff${i}, exec: ${f.exec} },`),
    "};",
    "",
  ].join("\n"),
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
  console.log(
    `built ${relative(root, outfile)} with ${files.length} UI files, the forwarder and ${feats.length} Feature files embedded`,
  );
} finally {
  await writeFile(gen, stub);
  await writeFile(machineGen, machineStub);
  await rm(staging, { recursive: true, force: true });
}
