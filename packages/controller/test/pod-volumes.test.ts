import { describe, expect, test } from "bun:test";
import type { Pod } from "@panem/core";
import { makeController, makeWorkspace, until } from "./helpers";

type Ctl = Awaited<ReturnType<typeof makeController>>;

async function summon(ctl: Ctl): Promise<Pod> {
  const res = await ctl.req("POST", "/api/pods", { template: "shop", machine: "m-vps" });
  if (res.status !== 202) throw new Error(`summon: ${res.status} ${await res.text()}`);
  const pod = (await res.json()) as Pod;
  await until(() => ["running", "error"].includes(ctl.service.get(pod.id).state));
  return ctl.service.get(pod.id);
}

const vps = { name: "m-vps", host: "vps", user: undefined, status: "online" };
const volumesOn = (ctl: Ctl) => [...(ctl.resourceShell.volumes.get("vps")?.keys() ?? [])];
const dindOf = (id: string) => `dind-var-lib-docker-default-${id}`;

/** One storage run, as the monitor's timer would do, then what it reports. */
async function measure(ctl: Ctl) {
  await ctl.service.refresh();
  await ctl.resources.runFast(vps);
  await ctl.resources.runSlow(vps);
  await ctl.service.resourcesChanged();
}

describe("resource usage through the controller", () => {
  test("machines and pods carry their figures; the pod's DinD volume is recorded", async () => {
    const ctl = await makeController(makeWorkspace());
    const pod = await summon(ctl);
    await measure(ctl);
    const m = ctl.service.machines().find((x) => x.name === "m-vps")!;
    expect(m.resources?.mem?.total).toBe(16 * 1024 ** 3);
    expect(m.resources?.disk?.path).toBe("/var/lib/docker");
    expect(m.resources?.orphans?.count).toBe(2);
    const p = ctl.service.get(pod.id);
    expect(p.resources?.mem).toBeGreaterThan(0);
    expect(p.resources?.writable).toBeGreaterThan(0);
    expect(p.resources?.dind).toBeGreaterThan(0);
    expect(ctl.service.get(pod.id).volumes).toEqual([dindOf(pod.id)]);
  });
});

describe("a pod's DinD volume is removed with it", () => {
  test("delete: removed after devpod delete", async () => {
    const ctl = await makeController(makeWorkspace());
    const pod = await summon(ctl);
    await measure(ctl);
    expect(volumesOn(ctl)).toContain(dindOf(pod.id));
    await ctl.req("DELETE", `/api/pods/${pod.id}?memory=false`);
    await ctl.service.idle();
    expect(ctl.service.podList()).toEqual([]);
    expect(volumesOn(ctl)).not.toContain(dindOf(pod.id));
    // Volumes that were never this pod's stay (the two leftovers from before).
    expect(volumesOn(ctl)).toHaveLength(2);
  });

  test("force delete with the machine offline: removed once it's back", async () => {
    const ctl = await makeController(makeWorkspace());
    const pod = await summon(ctl);
    await measure(ctl); // records the volume while reachable
    ctl.probe.statuses.vps = "offline";
    await ctl.service.refresh();
    await ctl.req("DELETE", `/api/pods/${pod.id}?force=true`);
    expect(ctl.logs.some((l) => l.includes("will be removed when m-vps is back"))).toBe(true);
    expect(volumesOn(ctl)).toContain(dindOf(pod.id));
    ctl.probe.statuses.vps = "online";
    await ctl.service.refresh();
    await ctl.resources.runSlow(vps);
    expect(volumesOn(ctl)).not.toContain(dindOf(pod.id));
  });
});

describe("pruning volumes Panem never recorded", () => {
  test("listed with sizes; removed when asked; a pod's own volume is refused", async () => {
    const ctl = await makeController(makeWorkspace());
    const pod = await summon(ctl);
    await measure(ctl);
    const list = (await (await ctl.req("GET", "/api/machines/m-vps/orphans")).json()) as {
      name: string;
      size: number;
    }[];
    expect(list.map((o) => o.name).sort()).toEqual([
      "dind-var-lib-docker-default-old-a1b2c3",
      "dind-var-lib-docker-default-old-d4e5f6",
    ]);
    expect(list.every((o) => o.size > 0)).toBe(true);
    const r = (await (
      await ctl.req("POST", "/api/machines/m-vps/prune", {
        volumes: ["dind-var-lib-docker-default-old-a1b2c3", dindOf(pod.id)],
      })
    ).json()) as { removed: { name: string }[]; skipped: { name: string; reason: string }[] };
    expect(r.removed.map((x) => x.name)).toEqual(["dind-var-lib-docker-default-old-a1b2c3"]);
    expect(r.skipped).toEqual([{ name: dindOf(pod.id), reason: "belongs to a pod" }]);
    expect(volumesOn(ctl)).not.toContain("dind-var-lib-docker-default-old-a1b2c3");
    expect((await ctl.req("POST", "/api/machines/m-vps/prune", { volumes: [] })).status).toBe(400);
  });
});
