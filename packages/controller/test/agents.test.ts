import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { makeController, makeWorkspace, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

async function summon(ctl: Ctl, template: string): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template, machine: "m-vps" });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

/** Workspace with an extra template "solo" that asks for specific credentials. */
function workspaceWith(env: string[]) {
  const ws = makeWorkspace();
  ws.pushFrom(
    "t1",
    "templates/solo/template.json",
    JSON.stringify({ repos: [{ name: "app", url: "https://example.com/app.git" }], env }),
  );
  ws.pushFrom("t2", "templates/solo/.devcontainer/devcontainer.json", "{}");
  return ws;
}

describe("credentials", () => {
  test("a template without `env` gets only the Claude token, as before", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController({ ...ws, agentEnv: { OPENAI_API_KEY: "sk-openai" } });
    const pod = await summon(ctl, "shop");
    const env = ctl.backend.pods.get(pod.id)!.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-xyz"); // the older claudeOauthToken setting
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PANEM_AGENT_ENV).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("a template gets exactly the credentials it lists; missing ones are only logged", async () => {
    const ws = workspaceWith(["OPENAI_API_KEY", "GEMINI_API_KEY"]);
    const logs: string[] = [];
    const ctl = await makeController({
      ...ws,
      agentEnv: { OPENAI_API_KEY: "sk-openai", OTHER_SECRET: "nope" },
    });
    (ctl.service as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
    const pod = await summon(ctl, "solo");
    expect(pod.state).toBe("running");
    const env = ctl.backend.pods.get(pod.id)!.env;
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OTHER_SECRET).toBeUndefined();
    expect(env.PANEM_AGENT_ENV).toBe("OPENAI_API_KEY,GEMINI_API_KEY");
    expect(logs.some((l) => l.includes("wants GEMINI_API_KEY, which isn't configured"))).toBe(true);
  });

  test("an empty list sends no credentials at all", async () => {
    const ws = workspaceWith([]);
    const ctl = await makeController(ws);
    const pod = await summon(ctl, "solo");
    const env = ctl.backend.pods.get(pod.id)!.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PANEM_AGENT_ENV).toBe("");
  });
});

describe("agents", () => {
  test("the pod's agents.json lands on the pod, after the start hook", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.agentsJson = JSON.stringify([
      {
        id: "claude-code",
        label: "Claude Code",
        connect: [{ label: "Open in Claude", url: "https://claude.ai/code" }],
      },
      { id: "other", label: "Other agent", connect: [] },
    ]);
    const pod = await summon(ctl, "shop");
    expect(pod.agents?.map((a) => a.id)).toEqual(["claude-code", "other"]);
    const api = (await (await ctl.req("GET", `/api/pods/${pod.id}`)).json()) as Pod;
    expect(api.agents?.[1]).toEqual({ id: "other", label: "Other agent", connect: [] });
  });

  test("a pod with no agents shows none", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.agentsJson = "[]";
    expect((await summon(ctl, "shop")).agents).toEqual([]);
  });

  test("pods built before agents were pluggable count as Claude Code", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.agentsJson = undefined; // an older Feature writes no agents.json
    const pod = await summon(ctl, "shop");
    expect(pod.state).toBe("running");
    expect(pod.agents?.map((a) => a.id)).toEqual(["claude-code"]);
  });

  test("credentials are read fresh at each summon", async () => {
    const ws = workspaceWith(["OPENAI_API_KEY"]);
    const ctl = await makeController(ws);
    const cfgPath = join(ws.root, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        workspaceDir: ws.dir,
        apiToken: "t".repeat(16),
        agentEnv: { OPENAI_API_KEY: "v1" },
      }),
    );
    const { createController } = await import("../src/server");
    const { Config } = await import("@panem/core");
    const c2 = await createController({
      config: Config.parse(JSON.parse(await Bun.file(cfgPath).text())),
      configPath: cfgPath,
      dataDir: ctl.dataDir,
      backend: ctl.backend,
      probe: ctl.probe,
      log: () => {},
    });
    await c2.service.refresh();
    writeFileSync(
      cfgPath,
      JSON.stringify({
        workspaceDir: ws.dir,
        apiToken: "t".repeat(16),
        agentEnv: { OPENAI_API_KEY: "v2" },
      }),
    );
    const pod = await c2.service.summon({ template: "solo", machine: "m-vps" });
    await until(() => c2.service.get(pod.id).state === "running");
    expect(ctl.backend.pods.get(pod.id)!.env.OPENAI_API_KEY).toBe("v2");
  });
});
