import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pod } from "@panem/core";
import { derivedConfig, parseJsonc } from "../src/devcontainer-config";
import { featuresHash } from "../src/machine-assets";
import { makeController, makeWorkspace, until } from "./helpers";

describe("the config DevPod is given", () => {
  test("JSONC: comments and trailing commas; // inside strings kept", () => {
    expect(
      parseJsonc(`{
        // a comment
        "image": "mcr.microsoft.com/x", /* block */
        "url": "https://example.com//path",
        "list": [1, 2,],
      }`),
    ).toEqual({ image: "mcr.microsoft.com/x", url: "https://example.com//path", list: [1, 2] });
  });

  test("Panem's Features get panemBuild; relative paths are rewritten for the new folder", () => {
    const raw = `{
      "build": { "dockerfile": "Dockerfile", "context": ".." },
      "features": {
        "ghcr.io/devcontainers/features/node:1": {},
        "./my-feature": { "x": 1 },
        "./panem-features/claude-code": { "permissionMode": "acceptEdits" }, // ours
      },
    }`;
    const d = derivedConfig(raw, "b1");
    expect(d?.ids).toEqual(["claude-code"]);
    const cfg = JSON.parse(d!.json);
    expect(cfg.features).toEqual({
      "ghcr.io/devcontainers/features/node:1": {},
      "../my-feature": { x: 1 },
      "./claude-code": { permissionMode: "acceptEdits", panemBuild: "b1" },
    });
    expect(cfg.build).toEqual({ dockerfile: "../Dockerfile", context: "../.." });
    // A different build is a different config, so DevPod's image cache key changes.
    expect(derivedConfig(raw, "b2")!.json).not.toBe(d!.json);
  });

  test("templates without Panem's Features are used as they are", () => {
    expect(
      derivedConfig('{"features":{"ghcr.io/fdhani/panem/claude-code:0":{}}}', "b"),
    ).toBeUndefined();
  });
});

describe("summon", () => {
  test("a template listing ./panem-features/ gets the generated config and the build check", async () => {
    const ws = makeWorkspace();
    ws.pushFrom(
      "t",
      "templates/shop/.devcontainer/devcontainer.json",
      '{\n  // mine\n  "image": "base",\n  "features": { "./panem-features/claude-code": {} }\n}\n',
    );
    const before = ws.read("templates/shop/.devcontainer/devcontainer.json");
    const ctl = await makeController(ws);
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    const pod = (await res.json()) as Pod;
    await until(() => ctl.service.get(pod.id).state === "running");
    const up = ctl.backend.lastUp!;
    expect(up.devcontainerPath).toBe(
      "templates/shop/.devcontainer/panem-features/devcontainer.json",
    );
    const build = await featuresHash();
    expect(up.env.PANEM_EXPECT_BUILD).toBe(build);
    const gen = JSON.parse(readFileSync(join(ws.dir, up.devcontainerPath), "utf8"));
    expect(gen.features["./claude-code"].panemBuild).toBe(build);
    expect(
      existsSync(
        join(ws.dir, "templates/shop/.devcontainer/panem-features/claude-code/install.sh"),
      ),
    ).toBe(true);
    // The template's own file is untouched.
    expect(ws.read("templates/shop/.devcontainer/devcontainer.json")).toBe(before);
  });

  test("other templates keep their own config and get no check", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
    const pod = (await res.json()) as Pod;
    await until(() => ctl.service.get(pod.id).state === "running");
    expect(ctl.backend.lastUp!.devcontainerPath).toBe(
      "templates/shop/.devcontainer/devcontainer.json",
    );
    expect(ctl.backend.lastUp!.env.PANEM_EXPECT_BUILD).toBeUndefined();
  });
});
