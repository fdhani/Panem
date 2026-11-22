import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CredentialInfo, Pod } from "@panem/core";
import { makeController, makeWorkspace, until } from "./helpers";

/** Workspace with "shop" (no env: the Claude token) and "solo" (asks for OPENAI_API_KEY). */
function workspace() {
  const ws = makeWorkspace();
  ws.pushFrom(
    "t1",
    "templates/solo/template.json",
    JSON.stringify({
      repos: [{ name: "app", url: "https://example.com/app.git" }],
      env: ["OPENAI_API_KEY"],
    }),
  );
  ws.pushFrom("t2", "templates/solo/.devcontainer/devcontainer.json", "{}");
  return ws;
}

async function setup() {
  const ws = workspace();
  const configPath = join(ws.root, "config.json");
  const ctl = await makeController({ ...ws, configPath });
  const list = async () => {
    const res = await ctl.req("GET", "/api/credentials");
    const text = await res.text();
    return { text, items: JSON.parse(text) as CredentialInfo[] };
  };
  return { ws, ctl, configPath, list };
}

describe("credentials API", () => {
  test("lists names, whether they're set and which templates use them; never values", async () => {
    const { list } = await setup();
    const { text, items } = await list();
    expect(items).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", set: true, usedBy: ["shop"] },
      { name: "OPENAI_API_KEY", set: false, usedBy: ["solo"] },
    ]);
    expect(text).not.toContain("oauth-xyz");
  });

  test("set applies to the next pod, stays write-only and keeps the config file private", async () => {
    const { ctl, configPath, list } = await setup();
    const put = await ctl.req("PUT", "/api/credentials/OPENAI_API_KEY", { value: " sk-new \n" });
    expect(put.status).toBe(204);
    const { text, items } = await list();
    const openai = items.find((i) => i.name === "OPENAI_API_KEY");
    expect(openai?.set).toBe(true);
    expect(Date.now() - Date.parse(openai?.updatedAt ?? "")).toBeLessThan(60_000);
    expect(text).not.toContain("sk-new");

    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.agentEnv.OPENAI_API_KEY).toBe("sk-new");
    expect(cfg.apiToken).toBeDefined(); // the rest of the config is untouched
    expect(cfg.workspaceDir).toBeDefined();
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const res = await ctl.req("POST", "/api/pods", { template: "solo", machine: "m-vps" });
    const pod = (await res.json()) as Pod;
    await until(() => ctl.service.get(pod.id).state === "running");
    expect(ctl.backend.pods.get(pod.id)!.env.OPENAI_API_KEY).toBe("sk-new");
  });

  test("remove clears the value, including the older claudeOauthToken setting", async () => {
    const { ctl, configPath, list } = await setup();
    expect(JSON.parse(readFileSync(configPath, "utf8")).claudeOauthToken).toBe("oauth-xyz");
    expect((await ctl.req("DELETE", "/api/credentials/CLAUDE_CODE_OAUTH_TOKEN")).status).toBe(204);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.claudeOauthToken).toBeUndefined();
    expect(cfg.agentEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(cfg.agentEnvUpdated.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // Still listed (shop needs it), now missing.
    expect((await list()).items[0]).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      set: false,
      usedBy: ["shop"],
    });
  });

  test("bad names and empty values are refused; the token is required", async () => {
    const { ctl } = await setup();
    for (const name of ["PANEM_RELAY_SECRET", "lower", "1BAD"]) {
      expect((await ctl.req("PUT", `/api/credentials/${name}`, { value: "x" })).status).toBe(400);
    }
    expect((await ctl.req("PUT", "/api/credentials/GOOD", { value: "  " })).status).toBe(400);
    expect((await ctl.req("PUT", "/api/credentials/GOOD", {})).status).toBe(400);
    const anon = await ctl.app.request("/api/credentials");
    expect(anon.status).toBe(401);
    const anonPut = await ctl.app.request("/api/credentials/GOOD", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(anonPut.status).toBe(401);
  });

  test("without a config file (mock), credentials are kept in memory", async () => {
    const ws = workspace();
    const ctl = await makeController(ws);
    await ctl.req("PUT", "/api/credentials/OPENAI_API_KEY", { value: "mem" });
    const items = (await (await ctl.req("GET", "/api/credentials")).json()) as CredentialInfo[];
    expect(items.find((i) => i.name === "OPENAI_API_KEY")?.set).toBe(true);
    expect(await ctl.credentials.all()).toMatchObject({ OPENAI_API_KEY: "mem" });
  });
});
