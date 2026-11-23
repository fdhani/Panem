import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { AgentInfo } from "@panem/core";
import { featureFiles, forwarderFile } from "./machine-assets.gen";

/**
 * What Panem itself puts on machines, carried by the controller instead of a registry (as
 * DevPod injects its own agent): the forwarder as one JS bundle, run with the public Bun image,
 * and the devcontainer Features as plain files. Embedded in the compiled binary; built from the
 * repo's sources in dev and tests.
 */
const repo = join(import.meta.dir, "../../..");

/** Feature ids Panem ships (folders under features/src). */
export const FEATURE_IDS = ["panem", "claude-code"] as const;

let bundle: Promise<string> | undefined;

/** The forwarder (packages/forwarder) as a single JS file for `bun forwarder.js`. */
export function forwarderBundle(): Promise<string> {
  bundle ??= (async () => {
    if (forwarderFile) return Bun.file(forwarderFile).text();
    return buildForwarder();
  })();
  return bundle;
}

/** Bundle the forwarder from source (used by scripts/build.ts, dev and tests). */
export async function buildForwarder(): Promise<string> {
  const r = await Bun.build({
    entrypoints: [join(repo, "packages/forwarder/src/main.ts")],
    target: "bun",
    minify: true,
  });
  if (!r.success || !r.outputs[0]) {
    throw new Error(`bundling the forwarder failed: ${r.logs.map(String).join("; ")}`);
  }
  return r.outputs[0].text();
}

/** Short content hash, to tell deployed versions apart without trusting version numbers. */
export function shortHash(s: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);
}

/** One hash of every file Panem's Features are made of: changes whenever any of them does. */
export async function featuresHash(): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of await panemFeatures()) h.update(`${f.path}\0${f.exec ? 1 : 0}\0`).update(f.data);
  return h.digest("hex").slice(0, 16);
}

export interface FeatureFile {
  /** "<feature id>/<path inside it>", e.g. "claude-code/install.sh". */
  path: string;
  data: Uint8Array;
  exec: boolean;
}

let features: Promise<FeatureFile[]> | undefined;

/** Every file of the shipped Features, sorted by path. */
export function panemFeatures(): Promise<FeatureFile[]> {
  features ??= (async () => {
    const embedded = Object.entries(featureFiles);
    if (embedded.length > 0) {
      const out: FeatureFile[] = [];
      for (const [path, f] of embedded) {
        out.push({
          path,
          data: new Uint8Array(await Bun.file(f.file).arrayBuffer()),
          exec: f.exec,
        });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    return readFeatures(join(repo, "features/src"));
  })();
  return features;
}

/** Read the Features from a features/src folder (dev, tests, and scripts/build.ts). */
export async function readFeatures(src: string): Promise<FeatureFile[]> {
  const out: FeatureFile[] = [];
  for (const id of FEATURE_IDS) {
    const root = join(src, id);
    for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const abs = join(e.parentPath, e.name);
      out.push({
        path: `${id}/${relative(root, abs).split("\\").join("/")}`,
        data: new Uint8Array(await readFile(abs)),
        exec: ((await stat(abs)).mode & 0o111) !== 0,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The agents Panem's Features ship (each <id>/agent/agent.json), as declared. Those with a
 * "login" block are the ones a person can sign in to.
 */
export async function shippedAgents(): Promise<AgentInfo[]> {
  const out: AgentInfo[] = [];
  for (const f of await panemFeatures()) {
    if (!/^[^/]+\/agent\/agent\.json$/.test(f.path)) continue;
    const a = AgentInfo.safeParse(
      (() => {
        try {
          return JSON.parse(new TextDecoder().decode(f.data));
        } catch {
          return undefined;
        }
      })(),
    );
    if (a.success) out.push(a.data);
  }
  return out;
}
