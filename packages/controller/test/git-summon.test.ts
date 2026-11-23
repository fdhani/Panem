import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { TOKEN, hasSsh, makeGitFixtures } from "./git-fixtures";
import { makeController, makeWorkspace, until } from "./helpers";

let fx: ReturnType<typeof makeGitFixtures>;
beforeAll(() => {
  fx = makeGitFixtures();
});
afterAll(() => fx.stop());

type Ctl = Awaited<ReturnType<typeof makeController>>;

/** A workspace whose "svc" template has these repos (and optional git token config). */
async function setup(repos: { name: string; url: string; ref: string }[], extra: object = {}) {
  const ws = makeWorkspace();
  ws.pushFrom(
    "t",
    "templates/svc/template.json",
    JSON.stringify({ repos, env: ["CLAUDE_CODE_OAUTH_TOKEN", "GITLAB_TOKEN"], ...extra }),
  );
  ws.pushFrom("t", "templates/svc/.devcontainer/devcontainer.json", "{}");
  const ctl = await makeController({
    ...ws,
    git: fx.access(),
    agentEnv: { GITLAB_TOKEN: TOKEN },
  });
  return { ws, ctl };
}

async function summon(ctl: Ctl) {
  return ctl.req("POST", "/api/pods", { template: "svc", machine: "m-vps" });
}

async function running(ctl: Ctl, res: Response): Promise<Pod> {
  expect(res.status).toBe(202);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

describe.skipIf(!hasSsh)("summon with SSH repos", () => {
  test("unknown host: refused before any pod is built, naming the repo and what to do", async () => {
    const { ctl } = await setup([{ name: "x", url: "git@unknown.example:x/y.git", ref: "main" }]);
    const res = await summon(ctl);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(
      "x (git@unknown.example:x/y.git): no host key: no host key for unknown.example",
    );
    expect(ctl.backend.lastUp).toBeUndefined();
    expect(ctl.service.podList()).toEqual([]);
  });

  test("no key for the host: refused with what to add", async () => {
    const { ctl } = await setup([{ name: "x", url: "git@nokey.example:x/y.git", ref: "main" }]);
    const res = await summon(ctl);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no credentials: no SSH key");
  });

  test("a missing branch is caught by the preflight", async () => {
    const { ctl } = await setup([
      { name: "backend", url: "git@gitlab-work:omnihr/service.git", ref: "nope" },
    ]);
    const res = await summon(ctl);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      'backend (git@gitlab-work:omnihr/service.git): no such branch or tag: no branch or tag "nope"',
    );
  });

  test("the right key: the pod gets host keys and the alias, the setup gets the agent, then it's gone", async () => {
    const { ctl } = await setup([
      { name: "backend", url: "git@gitlab-work:omnihr/service.git", ref: "dev" },
    ]);
    const pod = await running(ctl, await summon(ctl));
    expect(pod.state).toBe("running");
    const up = ctl.backend.lastUp!;
    expect(up.sshAuthSock).toBeDefined();
    // The agent only lived for the setup.
    await until(() => !existsSync(up.sshAuthSock!));
    const home = ctl.backend.home(pod.id);
    expect(readFileSync(join(home, ".panem/git/known_hosts"), "utf8")).toContain("gitlab.com ");
    expect(readFileSync(join(home, ".panem/git/ssh_config"), "utf8")).toContain(
      "Host gitlab-work\n  HostName gitlab.com",
    );
    // No key files ever reach the pod.
    const files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const e of files) {
      expect(readFileSync(join(e.parentPath, e.name), "utf8")).not.toContain("PRIVATE KEY");
    }
  });

  test("before-destroy hooks get a scoped agent for the pod's SSH hosts", async () => {
    const { ctl } = await setup([
      { name: "backend", url: "git@gitlab-work:omnihr/service.git", ref: "dev" },
    ]);
    const pod = await running(ctl, await summon(ctl));
    await ctl.req("DELETE", `/api/pods/${pod.id}?memory=false`);
    await ctl.service.idle();
    const hook = ctl.backend.execAgents.find((e) => e.id === pod.id && e.kind === "before-destroy");
    expect(hook?.sshAuthSock).toBeDefined();
    expect(existsSync(hook!.sshAuthSock!)).toBe(false);
  });
});

describe("summon with an HTTPS token", () => {
  const git = { git: { "git.test": { token: "GITLAB_TOKEN" } } };

  test("the token goes only into the git helper's file: not env, pod.json, logs or errors", async () => {
    const { ctl } = await setup(
      [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "dev" }],
      git,
    );
    const pod = await running(ctl, await summon(ctl));
    expect(pod.state).toBe("running");
    const up = ctl.backend.lastUp!;
    // Listed in the template's env too, yet never passed as an environment variable.
    expect(Object.values(up.env).join("\n")).not.toContain(TOKEN);
    expect(up.env.PANEM_AGENT_ENV).not.toContain("GITLAB_TOKEN");
    const withToken = (up.files ?? []).filter((f) => f.content.includes(TOKEN));
    expect(withToken.map((f) => [f.path, f.mode])).toEqual([["~/.config/panem/git-tokens", 0o600]]);
    expect(ctl.logs.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(ctl.service.get(pod.id))).not.toContain(TOKEN);
  });

  test("a wrong token is refused, and neither the error nor the logs contain it", async () => {
    const ws = makeWorkspace();
    ws.pushFrom(
      "t",
      "templates/svc/template.json",
      JSON.stringify({
        repos: [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "dev" }],
        ...git,
      }),
    );
    ws.pushFrom("t", "templates/svc/.devcontainer/devcontainer.json", "{}");
    const ctl = await makeController({
      ...ws,
      git: fx.access(),
      agentEnv: { GITLAB_TOKEN: "bad-tok-999" },
    });
    const res = await summon(ctl);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("svc (https://git.test/omnihr/service.git): no credentials");
    expect(body).not.toContain("bad-tok-999");
    expect(ctl.logs.join("\n")).not.toContain("bad-tok-999");
  });

  test("the Summon page's check shows the same problems before summoning", async () => {
    const { ctl } = await setup(
      [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "nope" }],
      git,
    );
    const res = await ctl.req("GET", "/api/templates/svc/git-check");
    const check = (await res.json()) as { checked: boolean; problems: { reason: string }[] };
    expect(check.checked).toBe(true);
    expect(check.problems.map((p) => p.reason)).toEqual(["no such ref"]);
  });
});

test("without managed git access (mock mode) nothing changes", async () => {
  const ws = makeWorkspace();
  const ctl = await makeController(ws);
  const res = await ctl.req("GET", "/api/templates/shop/git-check");
  expect(await res.json()).toEqual({ checked: false, problems: [] });
  const pod = await running(
    ctl,
    await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" }),
  );
  expect(pod.state).toBe("running");
  expect(ctl.backend.lastUp?.files).toBeUndefined();
});
