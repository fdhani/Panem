import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { makeController, makeWorkspace, sh, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

/** A workspace whose panem.json has these hooks (and the default sync). */
function withHooks(hooks: Record<string, string>) {
  const ws = makeWorkspace();
  ws.pushFrom("cfg", "panem.json", JSON.stringify({ sync: [{ preset: "claude-code" }], hooks }));
  return ws;
}

async function summon(ctl: Ctl, template = "shop"): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template, machine: "m-vps" });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

async function del(ctl: Ctl, id: string, query = "") {
  await ctl.req("DELETE", `/api/pods/${id}${query}`);
  await ctl.service.idle();
}

describe("afterMemorySave", () => {
  test("runs in the folder after a save, with the pod id and saved files", async () => {
    const ws = withHooks({
      afterMemorySave: 'echo "$PWD|$PANEM_POD_ID|$PANEM_SAVED_FILES" > ../hook.out',
    });
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- new\n");
    await del(ctl, pod.id);
    expect(ctl.service.podList()).toEqual([]);
    expect(readFileSync(join(ws.root, "hook.out"), "utf8").trim()).toBe(
      `${ws.dir}|${pod.id}|memory/api/MEMORY.md`,
    );
  });

  test("a real git round trip: the saved memory is committed and pushed", async () => {
    const ws = withHooks({
      afterMemorySave:
        'git add -A memory && git -c user.email=t@t -c user.name=t commit -qm "panem: memory from $PANEM_POD_ID" && git push -q origin HEAD:main',
    });
    const remote = join(ws.root, "remote.git");
    sh(ws.root, `git init -q --bare -b main ${remote}`);
    sh(
      ws.dir,
      `git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed && git remote add origin ${remote} && git push -q origin main`,
    );
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- pod\n");
    await del(ctl, pod.id);
    expect(sh(ws.root, `git --git-dir=${remote} log --format=%s main`).split("\n")[0]).toBe(
      `panem: memory from ${pod.id}`,
    );
    expect(sh(ws.root, `git --git-dir=${remote} show main:memory/api/MEMORY.md`)).toContain(
      "- pod",
    );
  });

  test("doesn't run when nothing changed, or when memory isn't saved", async () => {
    const ws = withHooks({ afterMemorySave: "echo ran >> ../hook.out" });
    const ctl = await makeController(ws);
    const unchanged = await summon(ctl);
    await del(ctl, unchanged.id);
    const skipped = await summon(ctl);
    ctl.backend.writeMemory(skipped.id, "api", "MEMORY.md", "- not saved\n");
    await del(ctl, skipped.id, "?memory=false");
    expect(ctl.service.podList()).toEqual([]);
    expect(() => readFileSync(join(ws.root, "hook.out"))).toThrow();
  });

  test("a failing or slow hook is logged, and the delete still finishes", async () => {
    const ws = withHooks({ afterMemorySave: 'echo "remote: denied" >&2; exit 4' });
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "- kept anyway\n");
    await del(ctl, pod.id);
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("- kept anyway");
    expect(
      ctl.logs.some((l) => l.includes("afterMemorySave failed with exit 4: remote: denied")),
    ).toBe(true);

    const slow = withHooks({ afterMemorySave: "sleep 5" });
    const ctl2 = await makeController({ ...slow, workspaceHookTimeoutSec: 1 });
    const pod2 = await summon(ctl2);
    ctl2.backend.writeMemory(pod2.id, "api", "MEMORY.md", "- x\n");
    const t0 = Date.now();
    await del(ctl2, pod2.id);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(ctl2.service.podList()).toEqual([]);
    expect(ctl2.logs.some((l) => l.includes("afterMemorySave timed out after 1s"))).toBe(true);
  });

  test("two saves at once run their hooks one after the other", async () => {
    const ws = withHooks({
      afterMemorySave:
        'echo "start $PANEM_POD_ID" >> ../order; sleep 0.2; echo "end $PANEM_POD_ID" >> ../order',
    });
    const ctl = await makeController(ws);
    const a = await summon(ctl);
    const b = await summon(ctl);
    ctl.backend.writeMemory(a.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- a\n");
    ctl.backend.writeMemory(b.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- b\n");
    await Promise.all([
      ctl.req("DELETE", `/api/pods/${a.id}`),
      ctl.req("DELETE", `/api/pods/${b.id}`),
    ]);
    await ctl.service.idle();
    await until(() => ctl.service.podList().length === 0);
    const lines = readFileSync(join(ws.root, "order"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    for (let i = 0; i < 4; i += 2) {
      expect(lines[i]!.replace("start ", "")).toBe(lines[i + 1]!.replace("end ", ""));
    }
  });
});

describe("beforeSummon", () => {
  test("runs before templates are read, so its changes apply to the same summon", async () => {
    // The hook brings in a template that isn't there yet (like a `git pull` would).
    const ws = withHooks({
      beforeSummon:
        'mkdir -p templates/fresh/.devcontainer && echo "{}" > templates/fresh/.devcontainer/devcontainer.json && echo \'{"repos":[{"name":"x","url":"https://example.com/x.git"}]}\' > templates/fresh/template.json && echo "$PANEM_TEMPLATE" > ../asked',
    });
    const ctl = await makeController(ws);
    const pod = await summon(ctl, "fresh");
    expect(pod.state).toBe("running");
    expect(readFileSync(join(ws.root, "asked"), "utf8").trim()).toBe("fresh");
  });

  test("a failing hook is logged and the summon goes ahead with the folder as it is", async () => {
    const ws = withHooks({ beforeSummon: 'echo "could not reach remote" >&2; exit 1' });
    const ctl = await makeController(ws);
    const pod = await summon(ctl);
    expect(pod.state).toBe("running");
    expect(
      ctl.logs.some((l) => l.includes("beforeSummon failed with exit 1: could not reach remote")),
    ).toBe(true);
  });
});

test("a misspelt hook name is a template error", async () => {
  const ws = withHooks({ afterSave: "true" });
  const ctl = await makeController(ws);
  const t = (await (await ctl.req("GET", "/api/templates")).json()) as {
    templates: unknown[];
    errors: { name: string; error: string }[];
  };
  expect(t.templates).toEqual([]);
  expect(t.errors.find((e) => e.name === "shop")?.error).toContain("hooks");
});
