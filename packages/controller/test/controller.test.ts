import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { TOKEN, makeController, makeWorkspace, sh, until } from "./helpers";

async function summonRunning(ctl: Awaited<ReturnType<typeof makeController>>, body = {}) {
  const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps", ...body });
  expect(res.status).toBe(202);
  const pod = (await res.json()) as Pod;
  expect(pod.state).toBe("creating");
  await until(() => ctl.service.get(pod.id).state === "running");
  return pod;
}

describe("api basics", () => {
  test("auth is required, health is not", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    expect((await ctl.app.request("/api/pods")).status).toBe(401);
    expect(
      (await ctl.app.request("/api/pods", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    // Query token is only accepted on the SSE endpoint.
    expect((await ctl.app.request(`/api/pods?token=${TOKEN}`)).status).toBe(401);
    expect((await ctl.app.request("/healthz")).status).toBe(200);
  });

  test("SSE sends a snapshot", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const ac = new AbortController();
    const res = await ctl.app.request(`/api/events?token=${TOKEN}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"type":"jobs"')) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    ac.abort();
    expect(text).toContain('"type":"machines"');
    expect(text).toContain('"type":"pods"');
  });

  test("templates load from the workspace repo and report broken ones", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const r = (await (await ctl.req("GET", "/api/templates")).json()) as {
      templates: { name: string; devcontainerPath: string }[];
      errors: { name: string }[];
    };
    expect(r.templates.map((t) => t.name)).toEqual(["shop"]);
    expect(r.templates[0]!.devcontainerPath).toBe("templates/shop/.devcontainer/devcontainer.json");
    expect(r.errors.map((e) => e.name)).toEqual(["broken"]);
  });

  test("machines: add, duplicate, remove", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const add = await ctl.req("POST", "/api/machines", { host: "homeserver.tail.ts.net" });
    expect(add.status).toBe(201);
    expect(((await add.json()) as { name: string }).name).toBe("m-homeserver");
    expect((await ctl.req("POST", "/api/machines", { host: "homeserver" })).status).toBe(409);
    expect((await ctl.req("POST", "/api/machines", { host: "bad host;" })).status).toBe(400);
    expect((await ctl.req("DELETE", "/api/machines/m-homeserver")).status).toBe(204);
    const list = (await (await ctl.req("GET", "/api/machines")).json()) as { name: string }[];
    expect(list.map((m) => m.name)).toEqual(["m-vps", "m-mac"]);
  });
});

describe("pod lifecycle", () => {
  test("summon passes refs, base commit and token to the backend", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl, { refs: { web: "feat/login" } });
    const env = ctl.backend.pods.get(pod.id)!.env;
    const meta = JSON.parse(env.PANEM_POD!);
    expect(meta.repos).toEqual([
      { name: "api", url: "https://example.com/api.git", ref: "develop" },
      { name: "web", url: "https://example.com/web.git", ref: "feat/login" },
    ]);
    expect(meta.workspaceSha).toBe(sh(ws.root, `git --git-dir=${ws.origin} rev-parse main`).trim());
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-xyz");
    const listed = (await (await ctl.req("GET", "/api/pods")).json()) as Pod[];
    expect(listed.map((p) => [p.id, p.state, p.machine])).toEqual([[pod.id, "running", "m-vps"]]);
  });

  test("summon validation", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const post = (b: unknown) => ctl.req("POST", "/api/pods", b);
    expect((await post({ template: "nope", machine: "m-vps" })).status).toBe(404);
    expect((await post({ template: "shop", machine: "m-nope" })).status).toBe(404);
    expect(
      (await post({ template: "shop", machine: "m-vps", refs: { web: "--evil" } })).status,
    ).toBe(400);
    expect((await post({ template: "shop", machine: "m-vps", refs: { zzz: "main" } })).status).toBe(
      400,
    );
    ctl.probe.statuses.vps = "offline";
    expect((await post({ template: "shop", machine: "m-vps" })).status).toBe(409);
  });

  test("failed up shows error and can be force deleted", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.failNext.up = "docker not running";
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    const pod = (await res.json()) as Pod;
    await until(() => ctl.service.get(pod.id).state === "error");
    expect(ctl.service.get(pod.id).error).toBe("docker not running");
    expect((await ctl.req("DELETE", `/api/pods/${pod.id}?force=true`)).status).toBe(204);
    expect(ctl.service.podList()).toEqual([]);
  });

  test("stop keeps the pod and never exports; start brings it back", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- new fact\n");
    expect((await ctl.req("POST", `/api/pods/${pod.id}/stop`)).status).toBe(202);
    await until(() => ctl.service.get(pod.id).state === "stopped");
    expect(ws.log()).toBe("seed\n");
    // Busy pods reject a second op.
    ctl.backend.delayMs = 50;
    await ctl.req("POST", `/api/pods/${pod.id}/start`);
    expect(ctl.service.get(pod.id).state).toBe("starting");
    expect((await ctl.req("POST", `/api/pods/${pod.id}/stop`)).status).toBe(409);
    await until(() => ctl.service.get(pod.id).state === "running");
  });
});

describe("delete and export", () => {
  test("delete exports memory with a union merge, then removes the pod", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl);
    ctl.backend.writeMemory(
      pod.id,
      "api",
      "MEMORY.md",
      "# API memory\n- uses postgres\n- pod fact\n",
    );
    ctl.backend.writeMemory(pod.id, "web", "notes/ui.md", "dark mode\n");
    // Meanwhile someone else updates the same file.
    ws.pushFrom("laptop", "memory/api/MEMORY.md", "# API memory\n- uses postgres\n- laptop fact\n");

    expect((await ctl.req("DELETE", `/api/pods/${pod.id}`)).status).toBe(202);
    await ctl.service.idle();
    expect(ctl.backend.pods.has(pod.id)).toBe(false);
    expect(ctl.service.podList()).toEqual([]);
    const mem = ws.read("memory/api/MEMORY.md");
    expect(mem).toContain("- laptop fact");
    expect(mem).toContain("- pod fact");
    expect(mem).not.toContain("<<<<<<<");
    expect(ws.read("memory/web/notes/ui.md")).toBe("dark mode\n");
    expect(ws.log().split("\n")[0]).toBe(`panem: export from ${pod.id}`);
  });

  test("two pods exporting the same file keep both sets of lines", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const a = await summonRunning(ctl);
    const b = await summonRunning(ctl);
    ctl.backend.writeMemory(a.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- from A\n");
    ctl.backend.writeMemory(b.id, "api", "MEMORY.md", "# API memory\n- uses postgres\n- from B\n");
    await Promise.all([
      ctl.req("DELETE", `/api/pods/${a.id}`),
      ctl.req("DELETE", `/api/pods/${b.id}`),
    ]);
    await ctl.service.idle();
    await until(() => ctl.service.podList().length === 0);
    const mem = ws.read("memory/api/MEMORY.md");
    expect(mem).toContain("- from A");
    expect(mem).toContain("- from B");
    expect(mem.match(/uses postgres/g)?.length).toBe(1);
  });

  test("unchanged memory deletes without a commit", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl);
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.log()).toBe("seed\n");
  });

  test("deleting a stopped pod starts it to read memory", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "x\n");
    await ctl.req("POST", `/api/pods/${pod.id}/stop`);
    await until(() => ctl.service.get(pod.id).state === "stopped");
    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("x");
  });

  test("push failure keeps the pod in error; retry succeeds", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "# API memory\n- keep me\n");
    const hook = join(ws.origin, "hooks/pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'denied by policy' >&2\nexit 1\n", { mode: 0o755 });

    await ctl.req("DELETE", `/api/pods/${pod.id}`);
    await ctl.service.idle();
    const failed = ctl.service.get(pod.id);
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("push");
    expect(ctl.backend.pods.has(pod.id)).toBe(true);

    sh(ws.root, `rm ${hook}`);
    expect((await ctl.req("POST", `/api/pods/${pod.id}/retry-export`)).status).toBe(202);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("- keep me");
  });

  test("offline machine blocks delete; force discards memory", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const pod = await summonRunning(ctl);
    ctl.backend.writeMemory(pod.id, "api", "MEMORY.md", "lost\n");
    ctl.probe.statuses.vps = "offline";
    await ctl.service.refresh();
    expect(ctl.service.get(pod.id).machineStatus).toBe("offline");
    const res = await ctl.req("DELETE", `/api/pods/${pod.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("force");
    expect((await ctl.req("DELETE", `/api/pods/${pod.id}?force=true`)).status).toBe(204);
    expect(ctl.service.podList()).toEqual([]);
    expect(ws.log()).toBe("seed\n");
  });

  test("pending export jobs resume after a controller restart", async () => {
    const ws = makeWorkspace();
    const first = await makeController(ws);
    const pod = await summonRunning(first);
    first.backend.writeMemory(pod.id, "api", "MEMORY.md", "after restart\n");
    // Simulate a crash right after the job was persisted.
    first.backend.failNext.exec = "connection lost";
    await first.req("DELETE", `/api/pods/${pod.id}`);
    await first.service.idle();
    const jobsPath = join(first.dataDir, "jobs.json");
    const jobs = JSON.parse(await Bun.file(jobsPath).text());
    jobs[0].status = "running";
    await Bun.write(jobsPath, JSON.stringify(jobs));

    // New controller process, same data dir and same machines/pods.
    const second = await makeController({ ...ws, dataDir: first.dataDir });
    second.backend.pods = first.backend.pods;
    await second.service.refresh();
    await second.service.resumeJobs();
    await second.service.idle();
    expect(second.service.podList()).toEqual([]);
    expect(ws.read("memory/api/MEMORY.md")).toContain("after restart");
  });

  test("rediscover rebuilds metadata from pod.json", async () => {
    const ws = makeWorkspace();
    const first = await makeController(ws);
    const pod = await summonRunning(first, { refs: { web: "feat/x" } });
    const second = await makeController(ws); // fresh data dir: cache lost
    second.backend.pods = first.backend.pods;
    await second.service.refresh();
    expect(second.service.get(pod.id).repos).toEqual([]);
    const r = await (await second.req("POST", "/api/rediscover")).json();
    expect(r).toEqual({ found: [pod.id], failed: [] });
    expect(second.service.get(pod.id).repos[1]!.ref).toBe("feat/x");
  });
});
