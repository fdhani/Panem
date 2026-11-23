import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { panemFeatures, readFeatures } from "../src/machine-assets";
import { makeController, makeWorkspace, sh, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

async function summon(ctl: Ctl, template = "shop"): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template, machine: "m-vps" });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

describe("Panem's Features are delivered with the workspace (no registry)", () => {
  test("summon writes them next to the template's devcontainer.json, exactly as in the repo", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    await summon(ctl);
    const dir = join(ws.dir, "templates/shop/.devcontainer/panem-features");
    const want = await readFeatures(join(import.meta.dir, "../../../features/src"));
    expect(want.map((f) => f.path)).toContain("claude-code/devcontainer-feature.json");
    expect(want.map((f) => f.path)).toContain("panem/install.sh");
    for (const f of want) {
      const p = join(dir, f.path);
      expect(Buffer.from(readFileSync(p)).equals(Buffer.from(f.data))).toBe(true);
      expect((statSync(p).mode & 0o111) !== 0).toBe(f.exec);
    }
    // Kept out of a git-backed workspace; DevPod still uploads them (it only reads .devpodignore).
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("*");
  });

  test("unchanged files aren't rewritten; stale and edited ones are fixed", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const first = await ctl.workspace.installFeatures(
      "templates/shop/.devcontainer/devcontainer.json",
    );
    expect(first.written).toBe((await panemFeatures()).length);
    const again = await ctl.workspace.installFeatures(
      "templates/shop/.devcontainer/devcontainer.json",
    );
    expect(again.written).toBe(0);

    const dir = join(ws.dir, "templates/shop/.devcontainer/panem-features");
    writeFileSync(join(dir, "claude-code/install.sh"), "tampered\n");
    writeFileSync(join(dir, "claude-code/left-from-an-old-version.sh"), "old\n");
    const fixed = await ctl.workspace.installFeatures(
      "templates/shop/.devcontainer/devcontainer.json",
    );
    expect(fixed.written).toBe(1);
    expect(readFileSync(join(dir, "claude-code/install.sh"), "utf8")).not.toBe("tampered\n");
    expect(existsSync(join(dir, "claude-code/left-from-an-old-version.sh"))).toBe(false);
  });

  test("cleanup leaves the generated config and a build in progress alone", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const path = "templates/shop/.devcontainer/devcontainer.json";
    await ctl.workspace.installFeatures(path);
    const dir = join(ws.dir, "templates/shop/.devcontainer/panem-features");
    // What another pod's `devpod up` has in this folder mid-build.
    mkdirSync(join(dir, ".devpod-internal/0-panem"), { recursive: true });
    writeFileSync(join(dir, ".devpod-internal/0-panem/install.sh"), "building\n");
    writeFileSync(join(dir, "devcontainer.json"), "{}");
    await ctl.workspace.installFeatures(path);
    expect(existsSync(join(dir, ".devpod-internal/0-panem/install.sh"))).toBe(true);
    expect(existsSync(join(dir, "devcontainer.json"))).toBe(true);
  });

  test("a git-backed workspace stays clean", async () => {
    const ws = makeWorkspace();
    sh(ws.dir, "git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed");
    const ctl = await makeController(ws);
    await summon(ctl);
    expect(sh(ws.dir, "git status --porcelain")).toBe("");
  });

  test("a template still listing the GHCR Feature gets a warning pointing at the local one", async () => {
    const ws = makeWorkspace();
    ws.pushFrom(
      "t",
      "templates/shop/.devcontainer/devcontainer.json",
      JSON.stringify({ features: { "ghcr.io/fdhani/panem/claude-code:0": {} } }),
    );
    const ctl = await makeController(ws);
    const t = (await (await ctl.req("GET", "/api/templates")).json()) as {
      warnings: { name: string; warning: string }[];
    };
    expect(t.warnings).toEqual([
      {
        name: "shop",
        warning: expect.stringContaining('Use "./panem-features/claude-code" instead'),
      },
    ]);
  });
});
