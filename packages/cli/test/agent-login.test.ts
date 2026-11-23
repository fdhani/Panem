import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Machine } from "@panem/core";

const main = join(import.meta.dir, "../src/main.ts");
const machines: Machine[] = [
  {
    name: "m-homeserver",
    host: "homeserver",
    status: "online",
    logins: [
      {
        agent: "claude-code",
        label: "Claude Code",
        loginLabel: "Sign in to Claude",
        state: "needs-sign-in",
        pods: [{ id: "omni-us8z59", state: "needs-login", shared: true }],
      },
      {
        agent: "codex",
        label: "Codex",
        loginLabel: "Sign in to Codex",
        state: "signed-in",
        pods: [{ id: "omni-us8z59", state: "running", shared: true }],
      },
    ],
  },
  {
    name: "m-vps",
    host: "vps",
    status: "online",
    logins: [
      {
        agent: "claude-code",
        label: "Claude Code",
        loginLabel: "Sign in to Claude",
        state: "no-pods",
        pods: [],
      },
    ],
  },
];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api/machines") return Response.json(machines);
    if (u.pathname === "/api/pods") return Response.json([]);
    return new Response(null, { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", main, ...args], {
    env: {
      ...process.env,
      PANEM_URL: `http://localhost:${server.port}`,
      PANEM_TOKEN: "t",
      PANEM_CONFIG: "/nonexistent/config.json",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await p.exited;
  return {
    code,
    out: (await new Response(p.stdout).text()).trim(),
    err: (await new Response(p.stderr).text()).trim(),
  };
}

test("agent-login with no machine lists what can be signed in to, on each machine", async () => {
  const r = await cli("agent-login");
  expect(r.code).toBe(0);
  const cells = r.out
    .split("\n")
    .slice(0, 4)
    .map((l) => l.split(/ {2,}/));
  expect(cells).toEqual([
    ["MACHINE", "AGENT", "SIGN-IN", "RUNNING PODS"],
    ["homeserver", "Claude Code (claude-code)", "needs sign-in", "omni-us8z59"],
    ["homeserver", "Codex (codex)", "signed in", "omni-us8z59"],
    ["vps", "Claude Code (claude-code)", "no running pod", "-"],
  ]);
  expect(r.out).toContain("panem agent-login <machine> [agent]");
});

test("a machine with no running pod for the agent: says to summon one first", async () => {
  const r = await cli("agent-login", "vps");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no running pod on vps has Claude Code");
});
