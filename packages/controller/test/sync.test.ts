import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { makeController, makeRepo, makeWorkspace, sh, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

async function summon(ctl: Ctl, template = "shop"): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template, machine: "m-vps" });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

/** Workspace with a panem.json using all three source kinds. */
function setup() {
  const ws = makeWorkspace();
  const overlay = makeRepo(ws.root, "overlay", {
    "api/CLAUDE.md": "api overlay instructions\n",
    "api/.specify/memory/constitution.md": "be kind\n",
  });
  const folder = join(ws.root, "claude-context");
  mkdirSync(join(folder, "skills/review"), { recursive: true });
  writeFileSync(join(folder, "skills/review/SKILL.md"), "review skill\n");
  writeFileSync(join(folder, "notes.md"), "base notes\n");
  ws.pushFrom(
    "cfg",
    "panem.json",
    JSON.stringify({
      sources: { overlay: { git: overlay.origin, ref: "main" }, local: { dir: folder } },
      sync: [
        { from: "CLAUDE.md", to: "~/.claude/CLAUDE.md" },
        {
          from: "memory/{repo}/**",
          to: "~/.claude/projects/-codebase-{repo}/memory/**",
          flow: "both",
        },
        { source: "overlay", from: "{repo}/**", to: "/codebase/{repo}/**", flow: "both" },
        { source: "local", from: "skills/**", to: "~/.claude/skills/**" },
        { source: "local", from: "notes.md", to: "~/notes.md", flow: "both" },
      ],
      exclude: ["**/.DS_Store"],
    }),
  );
  return { ws, overlay, folder };
}

describe("copy-in", () => {
  test("defaults (no panem.json) place files after setup and before the start hook", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    expect(pod.state).toBe("running");
    expect(ctl.backend.events).toEqual([
      `up:${pod.id}`,
      `upload:${pod.id}`,
      `hook:start:${pod.id}`,
    ]);
    expect(ctl.backend.readPodFile(pod.id, "~/.claude/CLAUDE.md")).toBe("be nice\n");
    expect(
      ctl.backend.readPodFile(pod.id, "~/.claude/projects/-codebase-api/memory/MEMORY.md"),
    ).toContain("uses postgres");
    // The merge base is the commit that was actually sent, and the pod's pod.json knows it.
    const head = sh(ws.root, `git --git-dir=${ws.origin} rev-parse main`).trim();
    expect(pod.workspaceSha).toBe(head);
    expect(pod.sync?.bases.workspace).toEqual({ commit: head });
    const podJson = JSON.parse(ctl.backend.readPodFile(pod.id, "~/.panem/pod.json")!);
    expect(podJson.sync.bases.workspace.commit).toBe(head);
  });

  test("all three source kinds, with overlays hidden from git", async () => {
    const { ws } = setup();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    expect(pod.state).toBe("running");
    const rd = (p: string) => ctl.backend.readPodFile(pod.id, p);
    expect(rd("/codebase/api/CLAUDE.md")).toBe("api overlay instructions\n");
    expect(rd("/codebase/api/.specify/memory/constitution.md")).toBe("be kind\n");
    expect(rd("~/.claude/skills/review/SKILL.md")).toBe("review skill\n");
    expect(rd("~/notes.md")).toBe("base notes\n");
    const api = ctl.backend.localPath(pod.id, "/codebase/api");
    expect(sh(api, "git status --porcelain")).toBe("");
    expect(Object.keys(pod.sync!.bases).sort()).toEqual(["local", "overlay", "workspace"]);
  });

  test("a failed copy-in leaves the pod in error and never starts the agent", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.failNext.upload = "connection reset";
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    const pod = (await res.json()) as Pod;
    await until(() => ctl.service.get(pod.id).state === "error");
    expect(ctl.service.get(pod.id).error).toContain("connection reset");
    expect(ctl.backend.events.some((e) => e.startsWith("hook:start"))).toBe(false);
  });

  test("bad rules are reported on the template and refuse summon", async () => {
    const ws = makeWorkspace();
    ws.pushFrom("cfg", "panem.json", JSON.stringify({ sync: [{ from: "../x", to: "~/x" }] }));
    const ctl = await makeController(ws);
    const t = (await (await ctl.req("GET", "/api/templates")).json()) as {
      templates: unknown[];
      errors: { name: string; error: string }[];
    };
    expect(t.templates).toEqual([]);
    expect(t.errors.find((e) => e.name === "shop")?.error).toContain("panem.json sync[0]");
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    expect(res.status).toBe(404);
  });
});

describe("export", () => {
  test("writes back to the workspace repo, the overlay repo and the folder", async () => {
    const { ws, overlay, folder } = setup();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(
      pod.id,
      "api",
      "MEMORY.md",
      "# API memory\n- uses postgres\n- learned\n",
    );
    ctl.backend.writePodFile(pod.id, "/codebase/api/specs/001/spec.md", "new spec\n");
    ctl.backend.writePodFile(
      pod.id,
      "/codebase/api/.specify/memory/constitution.md",
      "be kind\nand brief\n",
    );
    ctl.backend.writePodFile(pod.id, "~/notes.md", "base notes\npod notes\n");
    ctl.backend.writePodFile(pod.id, "~/.claude/skills/review/SKILL.md", "edited (copy-in only)\n");
    ctl.backend.writePodFile(pod.id, "/codebase/api/specs/.DS_Store", "junk");
    // Meanwhile the folder changes on the controller host.
    writeFileSync(join(folder, "notes.md"), "base notes\nhost notes\n");

    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("- learned");
    expect(overlay.read("api/specs/001/spec.md")).toBe("new spec\n");
    expect(overlay.read("api/.specify/memory/constitution.md")).toBe("be kind\nand brief\n");
    expect(() => overlay.read("api/specs/.DS_Store")).toThrow();
    const notes = readFileSync(join(folder, "notes.md"), "utf8");
    expect(notes).toContain("pod notes");
    expect(notes).toContain("host notes");
    // Copy-in-only files never come back.
    expect(readFileSync(join(folder, "skills/review/SKILL.md"), "utf8")).toBe("review skill\n");
    expect(overlay.log().split("\n")[0]).toBe(`panem: export from ${pod.id}`);
    // The dir source's snapshot is cleaned up with the pod.
    expect(existsSync(join(ctl.dataDir, "snapshots", pod.id))).toBe(false);
  });

  test("an empty overlay repo gets its first commit from the pod", async () => {
    const ws = makeWorkspace();
    const empty = makeRepo(ws.root, "fresh");
    ws.pushFrom(
      "cfg",
      "panem.json",
      JSON.stringify({
        sources: { fresh: { git: empty.origin } },
        sync: [{ source: "fresh", from: "{repo}/**", to: "/codebase/{repo}/**", flow: "both" }],
      }),
    );
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    expect(pod.state).toBe("running");
    expect(pod.sync?.bases.fresh).toEqual({ commit: "" });
    ctl.backend.writePodFile(pod.id, "/codebase/web/specs/a.md", "first\n");
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(empty.read("web/specs/a.md")).toBe("first\n");
  });

  test("uses the rules the pod started with, even if panem.json changed since", async () => {
    const ws = makeWorkspace();
    ws.pushFrom(
      "cfg",
      "panem.json",
      JSON.stringify({ sync: [{ from: "notes/**", to: "~/notes/**", flow: "both" }] }),
    );
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ws.pushFrom("cfg2", "panem.json", JSON.stringify({ sync: [] }));
    ctl.backend.writePodFile(pod.id, "~/notes/today.md", "kept\n");
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ws.read("notes/today.md")).toBe("kept\n");
  });

  test("a failing source fails the job; retry exports only what's left", async () => {
    const { ws, overlay } = setup();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "- from pod\n");
    ctl.backend.writePodFile(pod.id, "/codebase/api/specs/x.md", "spec\n");
    const hook = join(overlay.origin, "hooks/pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'overlay is read-only today' >&2\nexit 1\n", {
      mode: 0o755,
    });

    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    const failed = ctl.service.get(pod.id);
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("overlay");
    expect(ctl.backend.pods.has(pod.id)).toBe(true);
    const job = (await (await ctl.req("GET", "/api/jobs")).json()) as {
      jobs: { exported?: string[] }[];
    };
    // The folder and the workspace repo finished; only the overlay is left.
    expect(job.jobs[0]!.exported?.sort()).toEqual(["local", "workspace"]);
    const workspaceCommits = ws.log().split("\n").filter(Boolean).length;

    sh(ws.root, `rm ${hook}`);
    await ctl.req("POST", `/api/pods/${pod.id}/retry-export`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(overlay.read("api/specs/x.md")).toBe("spec\n");
    // The workspace repo wasn't exported twice.
    expect(ws.log().split("\n").filter(Boolean).length).toBe(workspaceCommits);
  });

  test("pods from before sync rules export memory with the defaults, incl. -workspace- paths", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    // Make it look like a pre-rename, pre-rules pod.
    const meta = { ...ctl.service.get(pod.id), sync: undefined };
    await (
      ctl.service as unknown as { d: { pods: { put(m: unknown): Promise<void> } } }
    ).d.pods.put(meta);
    ctl.backend.writePodFile(
      pod.id,
      "~/.claude/projects/-workspace-api/memory/old.md",
      "legacy fact\n",
    );
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ws.read("memory/api/old.md")).toBe("legacy fact\n");
  });
});
