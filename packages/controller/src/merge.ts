import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";

export interface MergeOutcome {
  /** New content for the source, or undefined to leave it as it is. */
  content?: Uint8Array;
  /** Why the pod's version was not used, if it wasn't. */
  note?: string;
}

const eq = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** A NUL byte means binary: never merge it line by line. */
export const isBinary = (b: Uint8Array | undefined) => b?.includes(0);

/**
 * Three-way merge of one file written back from a pod.
 * - unchanged in the pod since the base: leave the source alone (incl. a file deleted there)
 * - source unchanged since the base, or new on both sides only in the pod: take the pod's
 * - both changed, text: `git merge-file --union`, keeping both sides' lines
 * - both changed, binary: keep the source's copy and say so
 */
export async function mergeFile(
  current: Uint8Array | undefined,
  base: Uint8Array | undefined,
  pod: Uint8Array,
): Promise<MergeOutcome> {
  if (base !== undefined && eq(pod, base)) return {};
  if (current === undefined) {
    // Deleted in the source after the pod started, but changed in the pod: bring it back.
    return { content: pod };
  }
  if (eq(current, pod)) return {};
  if (base !== undefined && eq(current, base)) return { content: pod };
  if (isBinary(current) || isBinary(pod) || isBinary(base)) {
    return { note: "binary file changed on both sides; kept the source's copy" };
  }
  const merged = await gitMergeFile(current, base ?? new Uint8Array(), pod);
  return eq(merged, current) ? {} : { content: merged };
}

async function gitMergeFile(
  current: Uint8Array,
  base: Uint8Array,
  pod: Uint8Array,
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "panem-merge-"));
  try {
    const [c, b, p] = ["current", "base", "pod"].map((n) => join(dir, n)) as [
      string,
      string,
      string,
    ];
    await writeFile(c, ensureNl(current));
    await writeFile(b, ensureNl(base));
    await writeFile(p, ensureNl(pod));
    // Exit code is the number of conflicts; --union resolves them all.
    await git(dir, ["merge-file", "--union", c, b, p], false);
    return new Uint8Array(await readFile(c));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ensureNl(b: Uint8Array): Uint8Array {
  return b.length === 0 || b[b.length - 1] === 10 ? b : Buffer.concat([b, Buffer.from("\n")]);
}

/** Text convenience used by older callers and tests. */
export async function unionMerge(
  current: string | undefined,
  base: string | undefined,
  pod: string,
): Promise<string> {
  const enc = (s: string | undefined) => (s === undefined ? undefined : Buffer.from(s));
  const r = await mergeFile(enc(current), enc(base), Buffer.from(pod));
  return r.content ? Buffer.from(r.content).toString("utf8") : (current ?? pod);
}
