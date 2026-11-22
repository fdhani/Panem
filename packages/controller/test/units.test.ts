import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCommand } from "../src/exporter";
import { mergeFile, unionMerge } from "../src/merge";
import { APPLY_SYNC_SCRIPT, bashCommand } from "../src/pod/scripts";
import { parseTailscaleStatus } from "../src/probe";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

describe("merge", () => {
  test("union cases", async () => {
    expect(await unionMerge("cur\n", "base\n", "base\n")).toBe("cur\n");
    expect(await unionMerge(undefined, undefined, "pod\n")).toBe("pod\n");
    expect(await unionMerge("base\n", "base\n", "pod\n")).toBe("pod\n");
    const m = await unionMerge("a\nlaptop\n", "a\n", "a\npod\n");
    expect(m).toContain("laptop");
    expect(m).toContain("pod");
    expect(m).not.toContain("<<<");
  });

  test("unchanged in the pod leaves the source alone, even if deleted there", async () => {
    expect(await mergeFile(enc("new\n"), enc("old\n"), enc("old\n"))).toEqual({});
    expect(await mergeFile(undefined, enc("old\n"), enc("old\n"))).toEqual({});
    // Changed in the pod but deleted in the source: brought back.
    expect(dec((await mergeFile(undefined, enc("old\n"), enc("edited\n"))).content)).toBe(
      "edited\n",
    );
  });

  test("binary files are taken only if the source didn't change", async () => {
    const bin = (s: string) => new Uint8Array([0, ...enc(s)]);
    expect(dec((await mergeFile(bin("a"), bin("a"), bin("b"))).content)).toBe(dec(bin("b")));
    const both = await mergeFile(bin("c"), bin("a"), bin("b"));
    expect(both.content).toBeUndefined();
    expect(both.note).toContain("binary");
    // New in the pod, unknown to the source: taken.
    expect((await mergeFile(undefined, undefined, bin("b"))).content).toBeDefined();
  });
});

describe("tailscale", () => {
  test("parses peers by hostname and DNS name", () => {
    const m = parseTailscaleStatus(
      JSON.stringify({
        Self: { HostName: "homeserver" },
        Peer: {
          a: { HostName: "VPS", DNSName: "vps-1.tail.ts.net.", Online: true },
          b: { HostName: "macbook", Online: false },
        },
      }),
    );
    expect(m.get("homeserver")).toBe(true);
    expect(m.get("vps")).toBe(true);
    expect(m.get("vps-1")).toBe(true);
    expect(m.get("macbook")).toBe(false);
  });
});

/** A fake pod: a temp $HOME and code root, with commands run the way backends run them. */
function fakePod() {
  const root = mkdtempSync(join(tmpdir(), "panem-podscript-"));
  const home = join(root, "home");
  const code = join(root, "codebase");
  mkdirSync(home, { recursive: true });
  mkdirSync(code, { recursive: true });
  const run = (command: string, stdin?: Uint8Array) =>
    Bun.spawnSync(["bash", "-c", command], {
      env: { PATH: process.env.PATH!, HOME: home, PANEM_CODE_ROOT: code },
      stdin: stdin ?? "ignore",
    });
  const write = (p: string, content: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  const git = (dir: string, args: string) =>
    Bun.spawnSync(["bash", "-c", `git -C '${dir}' -c user.email=t@t -c user.name=t ${args}`]);
  const repo = (name: string) => {
    const dir = join(code, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init -q");
    return dir;
  };
  return { root, home, code, run, write, git, repo };
}

function tarOf(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "panem-stage-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return Bun.spawnSync(["tar", "-czf", "-", "-C", dir, "."]).stdout;
}

describe("apply-sync.sh (in-pod copy-in)", () => {
  test("places home files and overlays; never overwrites tracked files; hides overlays from git", () => {
    const pod = fakePod();
    const api = pod.repo("api");
    pod.write(join(api, "CLAUDE.md"), "committed by the team\n");
    pod.git(
      api,
      `add CLAUDE.md && git -C '${api}' -c user.email=t@t -c user.name=t commit -qm init`,
    );
    pod.write(join(pod.home, ".claude/keep.md"), "already here\n");

    const r = pod.run(
      bashCommand(APPLY_SYNC_SCRIPT, "apply"),
      tarOf({
        "home/.claude/CLAUDE.md": "global\n",
        "home/.claude/skills/a b/it's.md": "quoted name\n",
        "codebase/api/CLAUDE.md": "overlay version\n",
        "codebase/api/.specify/memory/constitution.md": "spec\n",
        "codebase/api/[weird]*.md": "glob chars\n",
        "codebase/ghost/x.md": "no such repo\n",
      }),
    );
    expect(r.exitCode).toBe(0);
    const stderr = r.stderr.toString();
    expect(readFileSync(join(pod.home, ".claude/CLAUDE.md"), "utf8")).toBe("global\n");
    expect(readFileSync(join(pod.home, ".claude/skills/a b/it's.md"), "utf8")).toBe(
      "quoted name\n",
    );
    expect(readFileSync(join(pod.home, ".claude/keep.md"), "utf8")).toBe("already here\n");
    // The team's committed CLAUDE.md wins.
    expect(readFileSync(join(api, "CLAUDE.md"), "utf8")).toBe("committed by the team\n");
    expect(stderr).toContain("overlay skipped api/CLAUDE.md: the repo tracks it");
    expect(stderr).toContain("overlay for ghost skipped");
    expect(readFileSync(join(api, ".specify/memory/constitution.md"), "utf8")).toBe("spec\n");
    // Overlay files are invisible to git and listed for export.
    expect(pod.git(api, "status --porcelain").stdout.toString()).toBe("");
    const list = readFileSync(join(pod.home, ".panem/overlays/api.list"), "utf8");
    expect(list).toContain(".specify/memory/constitution.md");
    expect(list).not.toContain("CLAUDE.md");
    // Running again doesn't duplicate entries.
    pod.run(
      bashCommand(APPLY_SYNC_SCRIPT, "apply"),
      tarOf({ "codebase/api/.specify/memory/constitution.md": "x\n" }),
    );
    const ex = readFileSync(join(api, ".git/info/exclude"), "utf8");
    expect(ex.split("\n").filter((l) => l === "/.specify/memory/constitution.md")).toHaveLength(1);
  });
});

describe("export.sh (in-pod copy-out)", () => {
  const decode = (out: Buffer) => {
    const [home, code, b64 = ""] = out.toString().split("\n");
    const dir = mkdtempSync(join(tmpdir(), "panem-exp-out-"));
    if (b64) {
      writeFileSync(join(dir, "x.tgz"), Buffer.from(b64, "base64"));
      Bun.spawnSync(["tar", "-xzf", join(dir, "x.tgz"), "-C", dir]);
    }
    const list = Bun.spawnSync(["bash", "-c", `cd '${dir}' && find . -type f ! -name x.tgz | sort`])
      .stdout.toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => `/${f.slice(2)}`);
    return { home, code, list };
  };

  test("collects the memory folders it's given, and nothing else", () => {
    const pod = fakePod();
    pod.write(join(pod.home, ".claude/projects/-codebase-api/memory/MEMORY.md"), "fact\n");
    pod.write(join(pod.home, ".claude/projects/-codebase-api/session.jsonl"), "{}\n");
    pod.write(join(pod.home, ".claude/skills/a/SKILL.md"), "copy-in only\n");
    const api = pod.repo("api");
    pod.write(join(api, "specs/001/spec.md"), "overlay work: saved by a hook, not by export\n");

    const r = pod.run(exportCommand(["~/.claude/projects/-codebase-api/memory", "~/missing"]));
    expect(r.exitCode).toBe(0);
    const { home, code, list } = decode(r.stdout);
    expect(home).toBe(pod.home);
    expect(code).toBe(pod.code);
    expect(list.map((f) => f.replace(pod.root, ""))).toEqual([
      "/home/.claude/projects/-codebase-api/memory/MEMORY.md",
    ]);
  });

  test("only home roots exist now: an overlay root is refused before reaching the pod", () => {
    expect(() => exportCommand(["/codebase/api"])).toThrow(/under ~\//);
  });

  test("nothing to collect is an empty, successful export", () => {
    const pod = fakePod();
    const r = pod.run(exportCommand(["~/.claude/projects/-codebase-api/memory"]));
    expect(r.exitCode).toBe(0);
    expect(decode(r.stdout).list).toEqual([]);
  });

  test("the size and file-count caps fail with a clear message", () => {
    const pod = fakePod();
    for (let i = 0; i < 5; i++) pod.write(join(pod.home, `notes/${i}.md`), `${i}\n`.repeat(100));
    const many = pod.run(exportCommand(["~/notes"], { maxFiles: 3 }));
    expect(many.exitCode).toBe(98);
    expect(many.stderr.toString()).toContain("5 files, over the limit of 3");
    const big = pod.run(exportCommand(["~/notes"], { maxBytes: 10 }));
    expect(big.exitCode).toBe(98);
    expect(big.stderr.toString()).toContain("over the limit of 10");
    expect(existsSync(join(pod.home, "notes/0.md"))).toBe(true);
  });
});
