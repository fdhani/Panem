import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError } from "@panem/core";
import {
  BOOTSTRAP_CREATE,
  DevPodBackend,
  KEEP_LOGS,
  failureSummary,
  parseProviders,
  parseStatus,
} from "../src";

let dir: string;
let log: string;
let dp: DevPodBackend;

function fake(key: string, out: string, code = 0, err = "") {
  writeFileSync(join(dir, `${key}.out`), out);
  writeFileSync(join(dir, `${key}.code`), String(code));
  if (err) writeFileSync(join(dir, `${key}.err`), err);
}
const calls = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("ARGS"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-devpod-"));
  log = join(dir, "log");
  writeFileSync(log, "");
  dp = new DevPodBackend({
    bin: join(import.meta.dir, "fake-devpod.sh"),
    env: { FAKE_DIR: dir, FAKE_LOG: log },
  });
});

describe("DevPodBackend", () => {
  test("up builds args and passes env through a file, not argv", async () => {
    await dp.up({
      id: "shop-abc123",
      machine: "m-vps",
      source: "git@github.com:me/ws.git",
      sourceRef: "main",
      devcontainerPath: "templates/shop/.devcontainer/devcontainer.json",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "secret", PANEM_POD: '{"id":"x"}' },
    });
    const l = readFileSync(log, "utf8");
    expect(calls()[0]).toContain(
      "up git@github.com:me/ws.git@main --id shop-abc123 --provider m-vps --ide none --open-ide=false --devcontainer-path templates/shop/.devcontainer/devcontainer.json --workspace-env-file",
    );
    expect(calls()[0]).not.toContain("secret");
    expect(l).toContain("ENV CLAUDE_CODE_OAUTH_TOKEN=secret");
    expect(l).toContain('ENV PANEM_POD={"id":"x"}');
    // DevPod skips Feature lifecycle hooks, so setup runs over ssh right after up...
    expect(calls()[1]).toStartWith("ARGS ssh shop-abc123 --start-services=false --command ");
    expect(calls()[1]).toContain("/usr/local/share/panem/post-create.sh");
    // ...but not the start hook: the controller copies synced files in first.
    expect(calls()[1]).not.toContain("post-start");
    expect(calls()).toHaveLength(2);
  });

  test("runHook start runs post-start over ssh", async () => {
    await dp.runHook("p1", "start");
    expect(calls()[0]).toStartWith(
      "ARGS ssh p1 --start-services=false --command if\\ \\[\\ -x\\ /usr/local/share/panem/post-start.sh",
    );
  });

  test("a failing pod setup fails up with its output", async () => {
    fake("ssh", "cloning x\nfatal: repository not found\n", 1);
    await expect(
      dp.up({ id: "a", machine: "m-a", source: "/s", devcontainerPath: "p", env: {} }),
    ).rejects.toThrow("pod setup failed: cloning x | fatal: repository not found");
  });

  test("up passes local folder sources without a branch suffix", async () => {
    await dp.up({
      id: "a",
      machine: "m-local",
      source: "/srv/ws",
      sourceRef: "main",
      devcontainerPath: "p",
      env: {},
    });
    expect(calls()[0]).toStartWith("ARGS up /srv/ws --id a");
  });

  test("up rejects env values with newlines", async () => {
    await expect(
      dp.up({
        id: "a",
        machine: "m-a",
        source: "s",
        devcontainerPath: "p",
        env: { X: "a\nb" },
      }),
    ).rejects.toThrow(BackendError);
  });

  test("errors surface the last stderr line", async () => {
    fake("stop", "", 1, "info doing things\nfatal: machine unreachable\n");
    await expect(dp.stop("x")).rejects.toThrow("devpod stop failed: fatal: machine unreachable");
  });

  test("list keeps only panem machines and attaches status", async () => {
    fake(
      "list",
      JSON.stringify([
        { id: "shop-1", provider: { name: "m-vps" }, source: { gitRepository: "x" } },
        { id: "other", provider: { name: "docker" } },
      ]),
    );
    fake("status-shop-1", JSON.stringify({ id: "shop-1", state: "Stopped" }));
    expect(await dp.list()).toEqual([{ id: "shop-1", machine: "m-vps", status: "stopped" }]);
  });

  test("status failure maps to unknown", async () => {
    fake("status-x", "", 1);
    expect(await dp.status("x")).toBe("unknown");
  });

  test("status timeout maps to unknown", async () => {
    const slow = new DevPodBackend({
      bin: join(import.meta.dir, "fake-devpod.sh"),
      env: { FAKE_DIR: dir, FAKE_LOG: log },
      statusTimeoutMs: 200,
    });
    writeFileSync(join(dir, "status-x.sleep"), "5");
    expect(await slow.status("x")).toBe("unknown");
  });

  test("start uses up <id>; delete passes force", async () => {
    await dp.start("p1");
    await dp.delete("p1", { force: true });
    expect(calls()[0]).toBe("ARGS up p1 --ide none --open-ide=false");
    expect(calls()[1]).toStartWith(
      "ARGS ssh p1 --start-services=false --command if\\ \\[\\ -x\\ /usr/local/share/panem/post-start.sh",
    );
    expect(calls()[2]).toBe("ARGS delete p1 --ignore-not-found --force");
  });

  test("exec returns raw bytes and exit code without throwing", async () => {
    fake("ssh", "payload", 3);
    const r = await dp.exec("p1", "cat x");
    expect(r.exitCode).toBe(3);
    expect(new TextDecoder().decode(r.stdout)).toBe("payload");
    expect(calls()[0]).toBe("ARGS ssh p1 --start-services=false --command cat\\ x");
  });

  test("addMachine registers ssh or docker providers", async () => {
    await dp.addMachine({ name: "m-vps", host: "vps", user: "me" });
    await dp.addMachine({ name: "m-local", host: "local" });
    expect(calls()[0]).toBe("ARGS provider add ssh --name m-vps -o HOST=me@vps");
    expect(calls()[1]).toBe("ARGS provider add docker --name m-local");
    await expect(dp.addMachine({ name: "vps", host: "vps" })).rejects.toThrow();
  });

  test("version check", async () => {
    fake("version", "v0.6.15\n");
    expect(await dp.version()).toEqual({ version: "v0.6.15", pinned: true });
    fake("version", "0.7.0\n");
    expect((await dp.version()).pinned).toBe(false);
  });
});

describe("parsers", () => {
  test("parseProviders reads HOST option in either shape", () => {
    const raw = JSON.stringify({
      "m-vps": { config: { name: "ssh" }, state: { options: { HOST: { value: "me@vps" } } } },
      "m-mac": { options: { HOST: "mac" } },
      "m-local": { config: { name: "docker" }, state: { options: {} } },
      docker: {},
    });
    expect(parseProviders(raw)).toEqual([
      { name: "m-local", host: "local" },
      { name: "m-mac", host: "mac" },
      { name: "m-vps", host: "vps", user: "me" },
    ]);
  });

  test("parseStatus", () => {
    expect(parseStatus('{"state":"Running"}')).toBe("running");
    expect(parseStatus('{"state":"NotFound"}')).toBe("notfound");
    expect(parseStatus("garbage")).toBe("unknown");
  });
});

describe("upload", () => {
  const exec = (extra: Record<string, string> = {}) =>
    new DevPodBackend({
      bin: join(import.meta.dir, "fake-devpod.sh"),
      env: { FAKE_DIR: dir, FAKE_LOG: log, FAKE_EXEC: "1", ...extra },
    });
  const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

  test("pipes bytes over stdin when devpod ssh passes it through", async () => {
    const be = exec();
    const data = bytes(200_000);
    const out = join(dir, "got");
    const r = await be.upload("p1", data, `cat > ${out}`);
    expect(r.exitCode).toBe(0);
    expect(new Uint8Array(readFileSync(out))).toEqual(data);
    expect(calls()).toHaveLength(1);
  });

  test("falls back to base64 chunks when stdin doesn't arrive, and remembers", async () => {
    const be = exec({ FAKE_DROP_STDIN: "1" });
    const data = bytes(150_000); // several chunks
    const out = join(dir, "got");
    const r = await be.upload("p1", data, `cat > ${out}; echo done`);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("done");
    expect(new Uint8Array(readFileSync(out))).toEqual(data);
    const first = calls().length;
    expect(first).toBeGreaterThan(3);
    // The second upload skips the stdin attempt.
    await be.upload("p1", bytes(10), `cat > ${out}`);
    expect(calls()[first]).not.toContain("wc");
  });

  test("the command's own failure is returned, not retried", async () => {
    const be = exec();
    const r = await be.upload("p1", bytes(10), "echo nope >&2; exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("nope");
    expect(calls()).toHaveLength(1);
  });
});

describe("git access for pods", () => {
  const socks = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("SOCK"))
      .map((l) => l.slice(5));

  test("startup turns off DevPod's key adding and git credential forwarding", async () => {
    await dp.configureContext();
    expect(calls()[0]).toBe(
      "ARGS context set-options -o SSH_ADD_PRIVATE_KEYS=false -o SSH_INJECT_GIT_CREDENTIALS=false",
    );
  });

  test("files go into the pod over stdin before setup; only setup gets the scoped agent", async () => {
    const home = mkdtempSync(join(tmpdir(), "fake-home-"));
    const be = new DevPodBackend({
      bin: join(import.meta.dir, "fake-devpod.sh"),
      env: { FAKE_DIR: dir, FAKE_LOG: log, FAKE_EXEC: "1", HOME: home },
    });
    await be.up({
      id: "p1",
      machine: "m-a",
      source: "/ws",
      devcontainerPath: "p",
      env: {},
      files: [
        { path: "~/.panem/git/known_hosts", content: "gitlab.com ssh-ed25519 AAAA\n", mode: 0o644 },
        { path: "~/.config/panem/git-tokens", content: "git.test oauth2 tok-1\n", mode: 0o600 },
      ],
      sshAuthSock: "/tmp/panem-agent-x/s",
    });
    expect(readFileSync(join(home, ".panem/git/known_hosts"), "utf8")).toContain("gitlab.com");
    expect(statSync(join(home, ".config/panem/git-tokens")).mode & 0o777).toBe(0o600);
    // The token travelled over stdin: never in any devpod argv.
    expect(calls().join("\n")).not.toContain("tok-1");
    // Upload first (no agent), then setup (with the agent).
    const c = calls();
    expect(c[1]).toContain("tar");
    expect(c[2]).toContain("post-create.sh");
    expect(socks()).toEqual(["", "/tmp/panem-agent-x/s"]);
  });

  test("an agent in the controller's own environment is never forwarded", async () => {
    const before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/home/me/.ssh/personal-agent.sock";
    try {
      await dp.exec("p1", "true");
      await dp.runHook("p1", "start");
      await dp.exec("p1", "hook", { sshAuthSock: "/tmp/scoped" });
    } finally {
      process.env.SSH_AUTH_SOCK = before ?? "";
    }
    expect(socks()).toEqual(["", "", "/tmp/scoped"]);
    for (const c of calls()) expect(c).toContain("--start-services=false");
  });

  test("a failed setup shows the scripts' own message (which repo, and git's words)", async () => {
    expect(
      failureSummary(
        "[panem] cloning git@gitlab.com:o/s.git@dev -> /codebase/backend\npanem: clone of backend (git@gitlab.com:o/s.git) at dev failed: git@gitlab.com: Permission denied (publickey).\nfatal tunnel to container: ssh session: Process exited with status 1",
      ),
    ).toBe(
      "clone of backend (git@gitlab.com:o/s.git) at dev failed: git@gitlab.com: Permission denied (publickey).",
    );
    expect(failureSummary("a\nb\nc")).toBe("a | b | c");
  });
});

describe("devpod up diagnostics", () => {
  test("a failed up keeps its cleaned output (escape codes gone, secrets hidden) and saves a log", async () => {
    const logDir = join(dir, "logs");
    const be = new DevPodBackend({
      bin: join(import.meta.dir, "fake-devpod.sh"),
      env: { FAKE_DIR: dir, FAKE_LOG: log },
      logDir,
    });
    fake(
      "up",
      "\x1b[36minfo\x1b[0m Creating devcontainer...\r\x1b[36minfo\x1b[0m Done step\n",
      1,
      "\x1b[90mdebug\x1b[0m using token super-secret-token-123\n\x1b[31mfatal\x1b[0m run agent command: Process exited with status 1\n",
    );
    let err: unknown;
    try {
      await be.up({
        id: "p1",
        machine: "m-a",
        source: "/ws",
        devcontainerPath: "p",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "super-secret-token-123" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BackendError);
    const e = err as BackendError;
    expect(e.message).toBe(
      "devpod up failed: fatal run agent command: Process exited with status 1",
    );
    expect(e.detail).toEqual([
      "info Done step",
      "debug using token ***",
      "fatal run agent command: Process exited with status 1",
    ]);
    const saved = readFileSync(join(logDir, "p1.log"), "utf8");
    expect(saved).toContain("===== devpod up");
    expect(saved).not.toContain("\x1b");
    expect(saved).not.toContain("super-secret-token-123");
    expect(await be.log("p1")).toBe(saved);
    expect(calls()[0]).toContain("--debug");
  });

  test("only the newest logs are kept", async () => {
    const logDir = join(dir, "logs");
    const be = new DevPodBackend({
      bin: join(import.meta.dir, "fake-devpod.sh"),
      env: { FAKE_DIR: dir, FAKE_LOG: log },
      logDir,
    });
    for (let i = 0; i < KEEP_LOGS + 3; i++) {
      await be.up({ id: `p${i}`, machine: "m-a", source: "/ws", devcontainerPath: "p", env: {} });
    }
    expect(readdirSync(logDir)).toHaveLength(KEEP_LOGS);
    expect(existsSync(join(logDir, `p${KEEP_LOGS + 2}.log`))).toBe(true);
  });
});

describe("setup refuses an image with older Panem Features", () => {
  const share = () => {
    const d = mkdtempSync(join(tmpdir(), "share-"));
    writeFileSync(join(d, "post-create.sh"), "#!/bin/sh\necho setup-ran\n", { mode: 0o755 });
    return d;
  };
  const run = (dir: string, env: Record<string, string>) =>
    Bun.spawnSync(["bash", "-c", BOOTSTRAP_CREATE.replaceAll("/usr/local/share/panem", dir)], {
      env: { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), "h-")), ...env },
    });

  test("matching build: setup runs", () => {
    const d = share();
    writeFileSync(join(d, "BUILD"), "abc123\n");
    const r = run(d, { PANEM_EXPECT_BUILD: "abc123" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("setup-ran");
  });

  test("a stale image fails with what to do; no expectation means no check", () => {
    const d = share();
    writeFileSync(join(d, "BUILD"), "old999\n");
    const r = run(d, { PANEM_EXPECT_BUILD: "abc123" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(
      "panem: this pod was built from a cached image with older Panem Features (build old999, expected abc123)",
    );
    expect(r.stdout.toString()).not.toContain("setup-ran");
    expect(failureSummary(r.stderr.toString())).toContain("Delete the image");
    expect(run(share(), {}).exitCode).toBe(0);
  });
});
