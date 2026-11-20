import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";

/**
 * Three-way union merge of one text file.
 * - pod unchanged since base: keep current
 * - nothing on our side: take pod
 * - otherwise git merge-file --union, which keeps lines from both sides instead of conflicting
 */
export async function unionMerge(
  current: string | undefined,
  base: string | undefined,
  pod: string,
): Promise<string> {
  if (base !== undefined && pod === base) return current ?? pod;
  if (current === undefined || current === base) return pod;
  if (current === pod) return current;
  const dir = await mkdtemp(join(tmpdir(), "panem-merge-"));
  try {
    const [c, b, p] = ["current", "base", "pod"].map((n) => join(dir, n)) as [
      string,
      string,
      string,
    ];
    await writeFile(c, ensureNl(current));
    await writeFile(b, ensureNl(base ?? ""));
    await writeFile(p, ensureNl(pod));
    // Exit code is the number of conflicts; with --union there are none to resolve.
    await git(dir, ["merge-file", "--union", c, b, p], false);
    return await readFile(c, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ensureNl(s: string): string {
  return s === "" || s.endsWith("\n") ? s : `${s}\n`;
}
