import { describe, expect, test } from "bun:test";
import type { Pod } from "@panem/core";
import { makeController, makeWorkspace, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

async function summonStarted(ctl: Ctl): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  return (await res.json()) as Pod;
}

describe("a build holds the workspace folder", () => {
  test("a write to the folder (a memory save) waits until the build is done", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.delayMs = 300; // the build takes a while
    const order: string[] = [];
    const up = ctl.backend.up.bind(ctl.backend);
    ctl.backend.up = (o) =>
      up({
        ...o,
        withFolder: (fn) =>
          o.withFolder!(async () => {
            order.push("build starts");
            try {
              return await fn();
            } finally {
              order.push("build ends");
            }
          }),
      });
    const pod = await summonStarted(ctl);
    await until(() => order.includes("build starts"));
    // What the delete job's memory save does: take the folder's lock to write into it.
    await ctl.workspace.lock.run(async () => {
      order.push("write");
    });
    expect(order).toEqual(["build starts", "build ends", "write"]);
    await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  });

  test("two summons build one after the other", async () => {
    const ws = makeWorkspace();
    const ctl = await makeController(ws);
    ctl.backend.delayMs = 150;
    let inside = 0;
    let most = 0;
    // Count builds in progress at once (the mock's build runs inside the lock it's given).
    const up = ctl.backend.up.bind(ctl.backend);
    ctl.backend.up = (o) => {
      const hold = o.withFolder;
      if (!hold) throw new Error("the build wasn't given the workspace lock");
      return up({
        ...o,
        withFolder: (fn) =>
          hold(async () => {
            most = Math.max(most, ++inside);
            try {
              return await fn();
            } finally {
              inside--;
            }
          }),
      });
    };
    const a = await summonStarted(ctl);
    const b = await summonStarted(ctl);
    await until(
      () =>
        ["running", "error"].includes(ctl.service.get(a.id).state) &&
        ["running", "error"].includes(ctl.service.get(b.id).state),
    );
    expect(ctl.service.get(a.id).state).toBe("running");
    expect(ctl.service.get(b.id).state).toBe("running");
    expect(most).toBe(1);
  });
});
