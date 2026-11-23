import { afterEach, describe, expect, test } from "bun:test";
import { type Machine, type Pod, machineLogins, pickLoginPod } from "@panem/core";
import { LOGIN_WS_PATH, type LoginEvent } from "../src/logins";
import { serveOptions } from "../src/server";
import { makeController, makeWorkspace, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

/** Any agent with a sign-in: nothing here is specific to Claude. */
const AGENTS = JSON.stringify([
  {
    id: "codex",
    label: "Codex",
    connect: [],
    login: { label: "Sign in to Codex" },
    status: { state: "needs-login", message: "needs a sign-in" },
  },
]);

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

async function setup() {
  const ws = makeWorkspace();
  const ctl = await makeController(ws);
  ctl.backend.agentsJson = AGENTS;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...serveOptions(ctl) });
  cleanup.push(() => server.stop(true));
  return { ctl, base: `http://127.0.0.1:${server.port}` };
}

async function summon(ctl: Ctl, machine = "m-vps"): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template: "shop", machine });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

const agentState = (ctl: Ctl, id: string) =>
  ctl.service.get(id).agents?.find((a) => a.id === "codex")?.status?.state;
const machine = (ctl: Ctl, name: string) =>
  ctl.service.machines().find((m) => m.name === name) as Machine;
const codexOn = (ctl: Ctl, name: string) =>
  machine(ctl, name).logins?.find((l) => l.agent === "codex");

/** Open the sign-in terminal, type `input` once it asks, and collect what happens. */
async function signIn(base: string, ticket: string, input: string) {
  const sock = new WebSocket(`${base.replace("http", "ws")}${LOGIN_WS_PATH}?ticket=${ticket}`);
  sock.binaryType = "arraybuffer";
  let screen = "";
  const events: LoginEvent[] = [];
  let typed = false;
  const closed = new Promise<void>((resolve) => {
    sock.onclose = () => resolve();
  });
  sock.onmessage = (m) => {
    if (typeof m.data === "string") {
      events.push(JSON.parse(m.data) as LoginEvent);
      return;
    }
    screen += new TextDecoder().decode(m.data as ArrayBuffer);
    if (!typed && screen.includes("Code:")) {
      typed = true;
      sock.send(new TextEncoder().encode(input));
    }
  };
  await closed;
  return { screen, events };
}

describe("machine sign-ins, worked out from pods (any agent)", () => {
  const pod = (id: string, m: string, state: string, shared?: boolean, podState = "running") =>
    ({
      id,
      machine: m,
      state: podState,
      agents: [
        {
          id: "codex",
          label: "Codex",
          connect: [],
          login: { label: "Sign in to Codex", shared },
          status: { state, message: "" },
        },
      ],
    }) as unknown as Pod;

  test("states: signed in, needs sign-in, no running pod, and pods keeping their own", () => {
    expect(machineLogins("m-a", [pod("p1", "m-a", "running", true)])[0]).toMatchObject({
      agent: "codex",
      label: "Codex",
      loginLabel: "Sign in to Codex",
      state: "signed-in",
    });
    expect(machineLogins("m-a", [pod("p1", "m-a", "needs-login", true)])[0]!.state).toBe(
      "needs-sign-in",
    );
    expect(machineLogins("m-a", [pod("p1", "m-a", "needs-login", true, "stopped")])[0]!.state).toBe(
      "no-pods",
    );
    // A pod signed in on its own (it can't share) doesn't make the machine signed in.
    expect(
      machineLogins("m-a", [
        pod("p1", "m-a", "running", false),
        pod("p2", "m-a", "needs-login", true),
      ])[0]!.state,
    ).toBe("needs-sign-in");
    expect(machineLogins("m-b", [pod("p1", "m-a", "running", true)])).toEqual([]);
  });

  test("the pod a sign-in runs in shares the machine's sign-in, and waits for one if it can", () => {
    const pods = [
      pod("own", "m-a", "needs-login", false),
      pod("fine", "m-a", "running", true),
      pod("waiting", "m-a", "needs-login", true),
    ];
    expect(pickLoginPod("m-a", "codex", pods)).toBe("waiting");
    expect(pickLoginPod("m-a", "nope", pods)).toBeUndefined();
  });
});

describe("signing in from the UI", () => {
  test("every machine lists the agents Panem ships with a sign-in, pods or not", async () => {
    const { ctl } = await setup();
    for (const m of ["m-vps", "m-mac"]) {
      expect(machine(ctl, m).logins).toEqual([
        {
          agent: "claude-code",
          label: "Claude Code",
          loginLabel: "Sign in to Claude",
          state: "no-pods",
          pods: [],
        },
      ]);
    }
  });

  test("no running pod with the agent: a clear 409", async () => {
    const { ctl } = await setup();
    const r = await ctl.req("POST", "/api/machines/m-vps/logins/codex", {});
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("summon one to sign in from");
  });

  test("the terminal needs a valid one-time ticket", async () => {
    const { ctl, base } = await setup();
    await summon(ctl);
    expect((await fetch(`${base}${LOGIN_WS_PATH}?ticket=nope`)).status).toBe(401);
    const { ticket } = (await (
      await ctl.req("POST", "/api/machines/m-vps/logins/codex", {})
    ).json()) as { ticket: string };
    await signIn(base, ticket, "\u0004"); // used once (and given up)
    expect((await fetch(`${base}${LOGIN_WS_PATH}?ticket=${ticket}`)).status).toBe(401);
  });

  test("one sign-in: every waiting pod on that machine starts, other machines' don't", async () => {
    const { ctl, base } = await setup();
    const a = await summon(ctl);
    const b = await summon(ctl);
    const elsewhere = await summon(ctl, "m-mac");
    expect(codexOn(ctl, "m-vps")?.state).toBe("needs-sign-in");

    const res = await ctl.req("POST", "/api/machines/m-vps/logins/codex", {});
    expect(res.status).toBe(201);
    const { ticket, pod } = (await res.json()) as { ticket: string; pod: string };
    expect([a.id, b.id]).toContain(pod);
    // A second sign-in for the same agent and machine waits for this one.
    const out = signIn(base, ticket, "code-123\r");
    await until(() => ctl.service.logins.inProgress().length === 1);
    expect((await ctl.req("POST", "/api/machines/m-vps/logins/codex", {})).status).toBe(409);

    const { screen, events } = await out;
    expect(screen).toContain("Open https://example.com/mock-login");
    expect(screen).toContain("Signed in.");
    expect(events[0]).toEqual({ type: "exit", code: 0 });
    expect(events[1]?.type).toBe("done");
    expect(new Set((events[1] as { restarted: string[] }).restarted)).toEqual(
      new Set([a.id, b.id]),
    );
    expect(agentState(ctl, a.id)).toBe("running");
    expect(agentState(ctl, b.id)).toBe("running");
    expect(agentState(ctl, elsewhere.id)).toBe("needs-login");
    expect(codexOn(ctl, "m-vps")?.state).toBe("signed-in");
    expect(codexOn(ctl, "m-mac")?.state).toBe("needs-sign-in");
    expect(ctl.service.logins.inProgress()).toEqual([]);

    // A pod summoned afterwards starts signed in.
    const c = await summon(ctl);
    expect(agentState(ctl, c.id)).toBe("running");
  });

  test("a sign-in that doesn't finish restarts nothing", async () => {
    const { ctl, base } = await setup();
    const a = await summon(ctl);
    const { ticket } = (await (
      await ctl.req("POST", "/api/machines/m-vps/logins/codex", {})
    ).json()) as { ticket: string };
    const { events } = await signIn(base, ticket, "\r");
    expect(events).toEqual([{ type: "exit", code: 1 }]);
    expect(agentState(ctl, a.id)).toBe("needs-login");
    expect(ctl.backend.events.some((e) => e.startsWith("restart:"))).toBe(false);
  });

  test("closing the terminal ends the sign-in", async () => {
    const { ctl, base } = await setup();
    await summon(ctl);
    const { ticket } = (await (
      await ctl.req("POST", "/api/machines/m-vps/logins/codex", {})
    ).json()) as { ticket: string };
    const sock = new WebSocket(`${base.replace("http", "ws")}${LOGIN_WS_PATH}?ticket=${ticket}`);
    await new Promise((r) => {
      sock.onmessage = r;
    });
    sock.close();
    await until(() => ctl.service.logins.inProgress().length === 0);
  });

  test("a sign-in run elsewhere (the CLI) reports done the same way", async () => {
    const { ctl } = await setup();
    const a = await summon(ctl);
    ctl.backend.interactiveArgv(a.id, "agent-login.sh codex"); // where the CLI would run it
    Bun.spawnSync([
      "bash",
      "-c",
      `mkdir -p ${ctl.backend.loginsDir}/m-vps && touch ${ctl.backend.loginsDir}/m-vps/codex`,
    ]);
    const r = await ctl.req("POST", "/api/machines/m-vps/logins/codex/done", { pod: a.id });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { restarted: string[] }).restarted).toEqual([a.id]);
    expect(agentState(ctl, a.id)).toBe("running");
  });
});
