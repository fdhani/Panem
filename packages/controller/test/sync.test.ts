import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Workspace with a panem.json using all three source kinds (copy-in) plus the Claude preset. */
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
        { preset: "claude-code" },
        { source: "overlay", from: "{repo}/**", to: "/codebase/{repo}/**" },
        { source: "local", from: "skills/**", to: "~/.claude/skills/**" },
        { source: "local", from: "notes.md", to: "~/notes.md" },
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
    // The memory sent is kept on the controller as the merge base for saving it back.
    expect(
      readFileSync(join(ctl.dataDir, "pods", pod.id, "memory-base/memory/api/MEMORY.md"), "utf8"),
    ).toContain("uses postgres");
    expect(JSON.parse(ctl.backend.readPodFile(pod.id, "~/.panem/pod.json")!).id).toBe(pod.id);
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

describe("an empty overlay repo is a valid source", () => {
  test("summon works with nothing in it yet", async () => {
    const ws = makeWorkspace();
    const empty = makeRepo(ws.root, "fresh");
    ws.pushFrom(
      "cfg",
      "panem.json",
      JSON.stringify({
        sources: { fresh: { git: empty.origin } },
        sync: [
          { preset: "claude-code" },
          { source: "fresh", from: "{repo}/**", to: "/codebase/{repo}/**" },
        ],
      }),
    );
    const ctl = await makeController(ws);
    expect((await summon(ctl)).state).toBe("running");
  });
});

describe("delete saves agent memory, and only that", () => {
  test("memory goes to the workspace folder; overlay, folder and copied files stay put", async () => {
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
    ctl.backend.writePodFile(pod.id, "/codebase/api/.specify/memory/constitution.md", "edited\n");
    ctl.backend.writePodFile(pod.id, "~/notes.md", "base notes\npod notes\n");
    ctl.backend.writePodFile(pod.id, "~/.claude/skills/review/SKILL.md", "edited\n");
    ctl.backend.writePodFile(pod.id, "~/.claude/CLAUDE.md", "edited\n");
    const overlayLog = overlay.log();

    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("- learned");
    expect(ws.read("CLAUDE.md")).toBe("be nice\n");
    expect(overlay.log()).toBe(overlayLog);
    expect(() => overlay.read("api/specs/001/spec.md")).toThrow();
    expect(overlay.read("api/.specify/memory/constitution.md")).toBe("be kind\n");
    expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("base notes\n");
    expect(readFileSync(join(folder, "skills/review/SKILL.md"), "utf8")).toBe("review skill\n");
  });

  test("a pod without agent memory saves nothing and just deletes", async () => {
    const ws = makeWorkspace();
    ws.pushFrom(
      "cfg",
      "panem.json",
      JSON.stringify({ sync: [{ from: "CLAUDE.md", to: "~/CLAUDE.md" }] }),
    );
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "not synced here\n");
    const before = ws.log();
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.log()).toBe(before);
  });

  test("uses the rules the pod started with, even if panem.json changed since", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summon(ctl); // defaults: the Claude preset, with memory
    ws.pushFrom("cfg", "panem.json", JSON.stringify({ sync: [] }));
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- kept\n");
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ws.read("memory/api/MEMORY.md")).toContain("- kept");
  });

  test("edits made in the workspace while the pod ran are kept (union merge)", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ws.pushFrom("me", "memory/api/MEMORY.md", "# API memory\n- uses postgres\n- from me\n");
    ctl.backend.writeMemory(
      pod.id,
      "api",
      "MEMORY.md",
      "# API memory\n- uses postgres\n- from pod\n",
    );
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    const merged = ws.read("memory/api/MEMORY.md");
    expect(merged).toContain("- from me");
    expect(merged).toContain("- from pod");
    expect(merged).not.toContain("<<<");
    // The merge base is gone with the pod.
    expect(existsSync(join(ctl.dataDir, "pods", pod.id))).toBe(false);
  });

  test("unchanged in the pod leaves the folder's newer copy alone", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ws.pushFrom("me", "memory/api/MEMORY.md", "rewritten on the controller\n");
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ws.read("memory/api/MEMORY.md")).toBe("rewritten on the controller\n");
  });

  test("a pod with no merge base (from before folders) keeps both sides' lines", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    rmSync(join(ctl.dataDir, "pods", pod.id), { recursive: true, force: true });
    ws.pushFrom("me", "memory/api/MEMORY.md", "# API memory\n- uses postgres\n- from me\n");
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- pod\n");
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    const merged = ws.read("memory/api/MEMORY.md");
    expect(merged).toContain("- from me");
    expect(merged).toContain("- pod");
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
