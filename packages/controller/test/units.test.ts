import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_COMMAND, mapToWorkspace } from "../src/exporter";
import { unionMerge } from "../src/merge";
import { parseTailscaleStatus } from "../src/probe";

const pod = {
  id: "p",
  template: "t",
  machine: "m-a",
  repos: [{ name: "api", url: "u", ref: "main" }],
  workspaceSha: "",
  createdAt: "",
};

describe("mapToWorkspace", () => {
  test("maps the pod's repos and ignores everything else", () => {
    expect(
      mapToWorkspace(
        [
          "./-codebase-api/memory/MEMORY.md",
          "-codebase-api/memory/sub/a.md",
          "-codebase-other/memory/x.md",
          "-home-me/memory/x.md",
          "-codebase-api/transcript.jsonl",
          "-codebase-api/memory/../../etc",
        ],
        pod,
      ).map((m) => m.dest),
    ).toEqual(["memory/api/MEMORY.md", "memory/api/sub/a.md"]);
  });

  test("pods from before the /codebase rename still export their memory", () => {
    expect(
      mapToWorkspace(["-workspace-api/memory/old.md", "-workspace-other/memory/x.md"], pod).map(
        (m) => m.dest,
      ),
    ).toEqual(["memory/api/old.md"]);
  });
});

describe("unionMerge", () => {
  test("cases", async () => {
    expect(await unionMerge("cur\n", "base\n", "base\n")).toBe("cur\n");
    expect(await unionMerge(undefined, undefined, "pod\n")).toBe("pod\n");
    expect(await unionMerge("base\n", "base\n", "pod\n")).toBe("pod\n");
    const m = await unionMerge("a\nlaptop\n", "a\n", "a\npod\n");
    expect(m).toContain("laptop");
    expect(m).toContain("pod");
    expect(m).not.toContain("<<<");
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

describe("EXPORT_COMMAND", () => {
  const run = (home: string) =>
    Bun.spawnSync(["sh", "-c", EXPORT_COMMAND], { env: { HOME: home, PATH: process.env.PATH! } });

  test("emits a base64 tarball of memory files only", () => {
    const home = mkdtempSync(join(tmpdir(), "panem-exp-"));
    const proj = join(home, ".claude/projects/-codebase-api");
    mkdirSync(join(proj, "memory"), { recursive: true });
    writeFileSync(join(proj, "memory/MEMORY.md"), "fact\n");
    writeFileSync(join(proj, "session.jsonl"), "{}\n");
    const r = run(home);
    expect(r.exitCode).toBe(0);
    const out = mkdtempSync(join(tmpdir(), "panem-exp-out-"));
    writeFileSync(join(out, "m.tgz"), Buffer.from(r.stdout.toString(), "base64"));
    const list = Bun.spawnSync(["tar", "-tzf", join(out, "m.tgz")]).stdout.toString();
    expect(list).toContain("./-codebase-api/memory/MEMORY.md");
    expect(list).not.toContain("session.jsonl");
  });

  test("no projects folder is an empty, successful export", () => {
    const r = run(mkdtempSync(join(tmpdir(), "panem-exp-")));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });
});
