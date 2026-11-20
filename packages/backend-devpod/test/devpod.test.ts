import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError } from "@panem/core";
import { DevPodBackend, parseProviders, parseStatus } from "../src";

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
    expect(calls()[1]).toBe("ARGS delete p1 --ignore-not-found --force");
  });

  test("exec returns raw bytes and exit code without throwing", async () => {
    fake("ssh", "payload", 3);
    const r = await dp.exec("p1", "cat x");
    expect(r.exitCode).toBe(3);
    expect(new TextDecoder().decode(r.stdout)).toBe("payload");
    expect(calls()[0]).toBe("ARGS ssh p1 --command cat\\ x");
  });

  test("addMachine registers ssh or docker providers", async () => {
    await dp.addMachine({ name: "m-vps", host: "vps", user: "me" });
    await dp.addMachine({ name: "m-local", host: "local" });
    expect(calls()[0]).toBe("ARGS provider add ssh --name m-vps --use=false -o HOST=me@vps");
    expect(calls()[1]).toBe("ARGS provider add docker --name m-local --use=false");
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
