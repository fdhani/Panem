import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ScopedAgent,
  defaultTokenUser,
  parseRepoUrl,
  parseSshG,
  redact,
  sshConfigText,
} from "../src/git-access";

import { TOKEN, hasSsh, makeGitFixtures } from "./git-fixtures";

describe("repo URLs", () => {
  test("SSH (scp-like and ssh://), HTTPS and local paths", () => {
    expect(parseRepoUrl("git@gitlab.com:omnihr/backend/service.git")).toEqual({
      scheme: "ssh",
      host: "gitlab.com",
      user: "git",
    });
    expect(parseRepoUrl("gitlab-work:team/x.git")).toEqual({
      scheme: "ssh",
      host: "gitlab-work",
      user: undefined,
    });
    expect(parseRepoUrl("ssh://git@git.corp:2222/x.git")).toEqual({
      scheme: "ssh",
      host: "git.corp",
      port: 2222,
      user: "git",
    });
    expect(parseRepoUrl("https://github.com/me/x.git")).toEqual({
      scheme: "https",
      host: "github.com",
    });
    expect(parseRepoUrl("/srv/repos/x.git").scheme).toBe("local");
  });

  test("refuses plain http and credentials in the URL, without echoing them", () => {
    expect(() => parseRepoUrl("http://github.com/me/x.git")).toThrow(/https:\/\/ or SSH/);
    let msg = "";
    try {
      parseRepoUrl("https://me:sekrit-tok@github.com/me/x.git");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('give the template a "git" token');
    expect(msg).not.toContain("sekrit-tok");
    expect(redact("https://a:b@h/x and https://t@h/y")).toBe("https://***@h/x and https://***@h/y");
    expect(defaultTokenUser("github.com")).toBe("x-access-token");
    expect(defaultTokenUser("gitlab.com")).toBe("oauth2");
  });

  test("ssh -G parsing and the pod's alias config", () => {
    const g = parseSshG(
      "hostname gitlab.com\nport 22\nidentityfile ~/.ssh/a\nidentityfile ~/.ssh/b\n",
    );
    expect(g.get("identityfile")).toEqual(["~/.ssh/a", "~/.ssh/b"]);
    expect(
      sshConfigText([
        {
          alias: "gitlab-work",
          hostname: "gitlab.com",
          port: 22,
          user: "git",
          keys: [],
          knownHosts: [],
        },
        { alias: "github.com", hostname: "github.com", port: 22, keys: [], knownHosts: [] },
      ]),
    ).toBe("Host gitlab-work\n  HostName gitlab.com\n  Port 22\n  User git\n");
  });
});

let fx: ReturnType<typeof makeGitFixtures>;
let home: string;
beforeAll(() => {
  fx = makeGitFixtures();
  home = fx.home;
});
afterAll(() => fx.stop());
const access = (extra: Record<string, unknown> = {}) => fx.access(extra);

describe.skipIf(!hasSsh)("SSH repos", () => {
  test("the right key: plan, a scoped agent with only that key, and a passing preflight", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "backend", url: "git@gitlab-work:omnihr/service.git", ref: "dev" }],
      undefined,
      {},
    );
    expect(plan.problems).toEqual([]);
    expect(plan.ssh[0]).toMatchObject({
      alias: "gitlab-work",
      hostname: "gitlab.com",
      user: "git",
    });
    expect(plan.ssh[0]!.keys).toEqual([join(home, ".ssh/gitlab_key")]);
    // The pod gets host keys and the alias, never a key file.
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      "~/.panem/git/known_hosts",
      "~/.panem/git/ssh_config",
    ]);
    expect(plan.files.map((f) => f.content).join("")).not.toContain("PRIVATE KEY");

    const agent = await a.agent(plan);
    try {
      const held = await agent!.list();
      expect(held).toContain("gitkey");
      expect(held).not.toContain("personal"); // the rest of ~/.ssh stays out
      expect(await a.preflight(plan, agent)).toEqual([]);
    } finally {
      await agent?.dispose();
    }
  });

  test("a branch that doesn't exist is caught before any pod is built", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "backend", url: "git@gitlab-work:omnihr/service.git", ref: "nope" }],
      undefined,
      {},
    );
    const agent = await a.agent(plan);
    try {
      expect(await a.preflight(plan, agent)).toEqual([
        expect.objectContaining({ repo: "backend", reason: "no such ref" }),
      ]);
    } finally {
      await agent?.dispose();
    }
  });

  test("unknown host: refused with how to add and check the host key", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "x", url: "git@unknown.example:x/y.git", ref: "main" }],
      undefined,
      {},
    );
    const p = plan.problems.find((x) => x.reason === "host key");
    expect(p?.message).toContain("no host key for unknown.example");
    expect(p?.message).toContain("check the fingerprint");
  });

  test("no credentials: no key for the host, or a key with a passphrase", async () => {
    const a = access();
    const none = await a.plan(
      [{ name: "x", url: "git@nokey.example:x/y.git", ref: "main" }],
      undefined,
      {},
    );
    expect(none.problems.find((p) => p.reason === "credentials")?.message).toContain(
      "no SSH key for nokey.example",
    );
    await expect(ScopedAgent.start([join(home, ".ssh/locked_key")])).rejects.toThrow(
      /passphrase|could not load/,
    );
  });

  test("without the agent the preflight reports the credentials problem", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "backend", url: "git@gitlab-work:omnihr/service.git", ref: "dev" }],
      undefined,
      {},
    );
    expect(await a.preflight(plan, undefined)).toEqual([
      expect.objectContaining({ repo: "backend", reason: "credentials" }),
    ]);
  });
});

describe("HTTPS repos with a token", () => {
  const git = { "git.test": { token: "GITLAB_TOKEN" } };

  test("the right token passes; the pod gets it only in the helper's file", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "dev" }],
      git,
      { GITLAB_TOKEN: TOKEN },
    );
    expect(plan.problems).toEqual([]);
    expect(plan.tokenNames).toEqual(["GITLAB_TOKEN"]);
    expect(await a.preflight(plan, undefined)).toEqual([]);
    const withToken = plan.files.filter((f) => f.content.includes(TOKEN));
    expect(withToken.map((f) => [f.path, f.mode])).toEqual([["~/.config/panem/git-tokens", 0o600]]);
  });

  test("a wrong token is a credentials problem, and the message never contains it", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "dev" }],
      git,
      { GITLAB_TOKEN: "wrong-token-456" },
    );
    const problems = await a.preflight(plan, undefined);
    expect(problems[0]?.reason).toBe("credentials");
    expect(JSON.stringify(problems)).not.toContain("wrong-token-456");
  });

  test("a token the controller doesn't have", async () => {
    const plan = await access().plan(
      [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "dev" }],
      git,
      {},
    );
    expect(plan.problems[0]).toMatchObject({ reason: "credentials" });
    expect(plan.problems[0]!.message).toContain("GITLAB_TOKEN isn't set");
  });

  test("an https repo with no token configured: preflight says it needs credentials", async () => {
    const a = access();
    const plan = await a.plan(
      [{ name: "svc", url: "https://git.test/omnihr/service.git", ref: "dev" }],
      undefined,
      {},
    );
    expect(plan.problems).toEqual([]);
    expect((await a.preflight(plan, undefined))[0]?.reason).toBe("credentials");
  });
});
