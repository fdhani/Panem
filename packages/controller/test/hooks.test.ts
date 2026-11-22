import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { makeController, makeWorkspace, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

/** Workspace whose "shop" template has a beforeDestroy hook. */
function workspaceWithHook(cmd: string) {
  const ws = makeWorkspace();
  ws.pushFrom(
    "t",
    "templates/shop/template.json",
    JSON.stringify({
      repos: [{ name: "api", url: "https://example.com/api.git", primary: true }],
      hooks: { beforeDestroy: cmd },
    }),
  );
  return ws;
}

async function summon(ctl: Ctl): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

async function del(ctl: Ctl, id: string, force = false) {
  await ctl.req("DELETE", `/api/pods/${id}${force ? "?force=true" : ""}`);
  await ctl.service.idle();
}

describe("before-destroy hooks", () => {
  test("agent hooks (by name), then the template's, run from /codebase before memory is saved", async () => {
    // The template hook appends to memory: seeing that line in the workspace repo proves the
    // hook ran in the pod before the save.
    const ws = workspaceWithHook(
      'echo "- noted by the hook in $PWD" >> "$HOME/.claude/projects/-codebase-api/memory/MEMORY.md"; echo "template" >> "$HOME/order"',
    );
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    expect(pod.hooks?.beforeDestroy).toContain("noted by the hook");
    ctl.backend.writeAgentHook(
      pod.id,
      "b-agent",
      "before-destroy.sh",
      '#!/bin/sh\necho "b" >> "$HOME/order"\n',
    );
    ctl.backend.writeAgentHook(
      pod.id,
      "a-agent",
      "before-destroy.sh",
      '#!/bin/sh\necho "a" >> "$HOME/order"\n',
    );
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n");
    const home = ctl.backend.home(pod.id);
    const code = ctl.backend.codeRoot(pod.id);

    // Read the order before the pod's folder is removed with it.
    let order = "";
    const orig = ctl.backend.delete.bind(ctl.backend);
    ctl.backend.delete = async (id, o) => {
      order = readFileSync(join(home, "order"), "utf8");
      return orig(id, o);
    };
    await del(ctl, pod.id);

    expect(order).toBe("a\nb\ntemplate\n");
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain(`- noted by the hook in ${code}`);
    const ev = ctl.backend.events.filter((e) => e.endsWith(pod.id));
    expect(ev.indexOf(`before-destroy:${pod.id}`)).toBeLessThan(
      ev.indexOf(`save-memory:${pod.id}`),
    );
  });

  test("a failing hook keeps the pod, shows its output, saves nothing; retry runs it again", async () => {
    const ws = workspaceWithHook(
      'if [ -f "$HOME/ok" ]; then echo pushed; else echo "remote: denied"; exit 3; fi',
    );
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "- would be saved\n");
    const before = ws.log();

    await del(ctl, pod.id);
    const failed = ctl.service.get(pod.id);
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("before-destroy hook (template) failed with exit 3");
    expect(failed.error).toContain("remote: denied");
    expect(ctl.backend.pods.has(pod.id)).toBe(true);
    expect(ws.log()).toBe(before);
    expect(
      readFileSync(join(ctl.backend.home(pod.id), ".panem/before-destroy.log"), "utf8"),
    ).toContain("remote: denied");

    ctl.backend.writePodFile(pod.id, "~/ok", "");
    await ctl.req("POST", `/api/pods/${pod.id}/retry-export`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("- would be saved");
  });

  test("a hook over its time limit fails clearly", async () => {
    const ws = workspaceWithHook("sleep 5");
    const ctl = await makeController({ ...ws, hookTimeoutSec: 1 });
    const pod = await summon(ctl);
    await del(ctl, pod.id);
    expect(ctl.service.get(pod.id).error).toContain("timed out after 1s");
  });

  test("delete without saving works on a running pod and skips hooks and the memory save", async () => {
    const ws = workspaceWithHook("exit 1");
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    expect(pod.state).toBe("running");
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "- not saved\n");
    const before = ws.log();
    await del(ctl, pod.id, true);
    expect(ctl.service.podList()).toEqual([]);
    expect(ctl.backend.pods.has(pod.id)).toBe(false);
    expect(ctl.backend.events).not.toContain(`before-destroy:${pod.id}`);
    expect(ctl.backend.events).not.toContain(`save-memory:${pod.id}`);
    expect(ws.log()).toBe(before);
  });

  test("the hook saved at summon runs, even if template.json changed since", async () => {
    const ws = workspaceWithHook('touch "$HOME/original-hook"');
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ws.pushFrom(
      "t2",
      "templates/shop/template.json",
      JSON.stringify({
        repos: [{ name: "api", url: "https://example.com/api.git" }],
        hooks: { beforeDestroy: 'touch "$HOME/new-hook"' },
      }),
    );
    const home = ctl.backend.home(pod.id);
    let ran: string[] = [];
    const orig = ctl.backend.delete.bind(ctl.backend);
    ctl.backend.delete = async (id, o) => {
      ran = ["original-hook", "new-hook"].filter((f) => existsSync(join(home, f)));
      return orig(id, o);
    };
    await del(ctl, pod.id);
    expect(ran).toEqual(["original-hook"]);
  });

  test("hooks run even for pods without agent memory", async () => {
    const ws = workspaceWithHook('touch "$HOME/hooked"');
    ws.pushFrom("cfg", "panem.json", JSON.stringify({ sync: [] }));
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    const home = ctl.backend.home(pod.id);
    let hooked = false;
    const orig = ctl.backend.delete.bind(ctl.backend);
    ctl.backend.delete = async (id, o) => {
      hooked = existsSync(join(home, "hooked"));
      return orig(id, o);
    };
    await del(ctl, pod.id);
    expect(hooked).toBe(true);
  });
});
