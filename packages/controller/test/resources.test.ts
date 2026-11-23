import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@panem/core";
import {
  FAST_SCRIPT,
  ResourceMonitor,
  type ResourcePod,
  SLOW_BACKOFF_MS,
  SLOW_SCRIPT,
  dindVolumes,
  parseDf,
  parseMeminfo,
  parseMounts,
  parsePsSize,
  parseSize,
  parseStatsMem,
  parseVolumes,
  sections,
} from "../src/resources";
import type { MachineShell, ShellResult } from "../src/shell";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe("parsers", () => {
  test("Docker sizes: decimal (ps -s, system df) and binary (stats) units", () => {
    expect(parseSize("0B")).toBe(0);
    expect(parseSize("512B")).toBe(512);
    expect(parseSize("12.3kB")).toBe(12_300);
    expect(parseSize("1.15GB")).toBe(1_150_000_000);
    expect(parseSize("3MB")).toBe(3_000_000);
    expect(parseSize("1.2TB")).toBe(1_200_000_000_000);
    expect(parseSize("4KiB")).toBe(4096);
    expect(parseSize("255.7MiB")).toBe(Math.round(255.7 * MiB));
    expect(parseSize("15.5GiB")).toBe(Math.round(15.5 * GiB));
    expect(parseSize("1TiB")).toBe(1024 ** 4);
    expect(parseSize("N/A")).toBeUndefined();
    expect(parseSize("")).toBeUndefined();
  });

  test("/proc/meminfo: MemAvailable, not MemFree; kB is KiB", () => {
    const info = [
      "MemTotal:       16303212 kB",
      "MemFree:          452608 kB",
      "MemAvailable:   11954232 kB",
      "Buffers:          201564 kB",
    ].join("\n");
    expect(parseMeminfo(info)).toEqual({ total: 16303212 * 1024, available: 11954232 * 1024 });
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeUndefined(); // very old kernels: no MemAvailable
  });

  test("df -Pk: total and available on Docker's filesystem", () => {
    const out = [
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/nvme0n1p2   479595076 334507228 120654848      74% /",
    ].join("\n");
    expect(parseDf(out)).toEqual({ total: 479595076 * 1024, free: 120654848 * 1024 });
    expect(parseDf("")).toBeUndefined();
  });

  test("docker stats MemUsage and docker ps -s Size", () => {
    expect(parseStatsMem("255.7MiB / 15.5GiB")).toBe(Math.round(255.7 * MiB));
    expect(parseStatsMem("0B / 0B")).toBe(0);
    expect(parsePsSize("1.15GB (virtual 3.13GB)")).toEqual({
      writable: 1_150_000_000,
      virtual: 3_130_000_000,
    });
    expect(parsePsSize("0B (virtual 1.02GB)")).toEqual({ writable: 0, virtual: 1_020_000_000 });
    expect(parsePsSize("12kB")).toEqual({ writable: 12_000, virtual: undefined });
  });

  test("docker system df -v volumes: the table's shape and the API's", () => {
    const table = JSON.stringify([
      { Driver: "local", Links: "1", Name: "dind-var-lib-docker-default-ab", Size: "2.31GB" },
      { Driver: "local", Links: "0", Name: "dind-var-lib-docker-default-cd", Size: "415.2MB" },
      { Driver: "local", Links: "3", Name: "panem-logins", Size: "4.1kB" },
    ]);
    expect(parseVolumes(table)).toEqual([
      { name: "dind-var-lib-docker-default-ab", size: 2_310_000_000, links: 1 },
      { name: "dind-var-lib-docker-default-cd", size: 415_200_000, links: 0 },
      { name: "panem-logins", size: 4100, links: 3 },
    ]);
    const api = JSON.stringify([{ Name: "x", UsageData: { Size: 1234, RefCount: 0 } }]);
    expect(parseVolumes(api)).toEqual([{ name: "x", size: 1234, links: 0 }]);
    expect(parseVolumes("null")).toEqual([]);
    expect(parseVolumes("")).toEqual([]);
  });

  test("docker inspect mounts: the pod's own DinD volume only", () => {
    const p = parseMounts(
      "4f1cabc\tbind||/workspaces/omni-hkogdw;volume|panem-logins|/var/lib/panem/logins;volume|dind-var-lib-docker-default-ab|/var/lib/docker;volume|npm-cache|/home/vscode/.npm;",
    )!;
    expect(p.id).toBe("4f1cabc");
    expect(dindVolumes(p.mounts)).toEqual(["dind-var-lib-docker-default-ab"]);
    expect(parseMounts("")).toBeUndefined();
  });
});

// ---------- the monitor, against a fake machine ----------

const FAST_OUT = [
  "@@panem:os",
  "Linux",
  "@@panem:mem",
  "MemTotal:       16303212 kB",
  "MemAvailable:   11954232 kB",
  "@@panem:pods",
  "4f1cabcdef01\tdefault-om-ab",
  "9a9a9a9a9a9a\tdefault-ot-xy",
  "@@panem:stats",
  "4f1cabcdef01\t255.7MiB / 15.5GiB",
  "9a9a9a9a9a9a\t1GiB / 15.5GiB",
  "",
].join("\n");

const SLOW_OUT = [
  "@@panem:root",
  "/var/lib/docker",
  "@@panem:df",
  "Filesystem     1024-blocks      Used Available Capacity Mounted on",
  "/dev/nvme0n1p2   479595076 334507228 120654848      74% /",
  "@@panem:ps",
  "4f1cabcdef01\tdefault-om-ab\tvsc-omni-123:devpod\t1.15GB (virtual 3.13GB)",
  "5b5b5b5b5b5b\tdefault-om-cd\tvsc-omni-123:devpod\t200MB (virtual 2.18GB)",
  "9a9a9a9a9a9a\tdefault-ot-xy\tother:latest\t5GB (virtual 6GB)",
  "@@panem:mounts",
  "4f1cabcdef01aaaa\tbind||/workspaces/omni-a;volume|panem-logins|/var/lib/panem/logins;volume|dind-var-lib-docker-default-om-ab|/var/lib/docker;",
  "5b5b5b5b5b5baaaa\tvolume|dind-var-lib-docker-default-om-cd|/var/lib/docker;",
  "9a9a9a9a9a9aaaaa\tvolume|dind-var-lib-docker-default-ot-xy|/var/lib/docker;",
  "@@panem:volumes",
  JSON.stringify([
    { Name: "dind-var-lib-docker-default-om-ab", Links: "1", Size: "2GB" },
    { Name: "dind-var-lib-docker-default-om-cd", Links: "1", Size: "500MB" },
    { Name: "dind-var-lib-docker-default-ot-xy", Links: "1", Size: "9GB" },
    { Name: "dind-var-lib-docker-default-old1", Links: "0", Size: "3GB" },
    { Name: "dind-var-lib-docker-default-old2", Links: "0", Size: "1GB" },
    { Name: "panem-logins", Links: "2", Size: "4kB" },
    { Name: "npm-cache", Links: "0", Size: "1GB" },
  ]),
  "",
].join("\n");

class FakeShell implements MachineShell {
  calls: string[] = [];
  fast = FAST_OUT;
  slow = SLOW_OUT;
  fail = false;
  delay = 0;
  /** Volumes a container still uses (removal reports in-use). */
  inUse = new Set<string>();
  removed: string[] = [];
  /** Called on every run (e.g. to move a fake clock). */
  onRun?: () => void;
  async run(_m: { host: string }, argv: string[]): Promise<ShellResult> {
    this.onRun?.();
    const script = argv.at(-1) ?? "";
    this.calls.push(script === FAST_SCRIPT ? "fast" : script === SLOW_SCRIPT ? "slow" : script);
    if (this.delay) await Bun.sleep(this.delay);
    if (this.fail) return { code: 255, stdout: "", stderr: "ssh: connect to host vps: timed out" };
    if (script === FAST_SCRIPT) return { code: 0, stdout: this.fast, stderr: "" };
    if (script === SLOW_SCRIPT) return { code: 0, stdout: this.slow, stderr: "" };
    const rm = script.match(/docker volume rm (\S+)/);
    if (rm) {
      const name = rm[1]!;
      if (this.inUse.has(name)) return { code: 0, stdout: "in-use\n", stderr: "" };
      this.removed.push(name);
      return { code: 0, stdout: "removed\n", stderr: "" };
    }
    if (script.includes("label=dev.containers.id=")) {
      return {
        code: 0,
        stdout:
          "4f1cabcdef01aaaa\tvolume|panem-logins|/var/lib/panem/logins;volume|dind-var-lib-docker-default-om-ab|/var/lib/docker;volume|npm-cache|/home/x;\n",
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  }
}

const vps = { name: "m-vps", host: "vps", status: "online" };

function monitor(
  o: {
    shell?: FakeShell;
    pods?: ResourcePod[];
    now?: () => number;
    dataDir?: string;
    thresholds?: Partial<Config["resources"]>;
  } = {},
) {
  const shell = o.shell ?? new FakeShell();
  const logs: string[] = [];
  let changes = 0;
  const pods = o.pods ?? [
    { id: "omni-a", machine: "m-vps", uid: "default-om-ab" },
    { id: "omni-b", machine: "m-vps", uid: "default-om-cd" },
  ];
  const mon = new ResourceMonitor({
    shell,
    machines: () => [vps],
    pods: () => pods,
    thresholds: () => ({
      ...Config.parse({ apiToken: "x".repeat(16) }).resources,
      ...o.thresholds,
    }),
    onChange: () => {
      changes++;
    },
    log: (m) => logs.push(m),
    dataDir: o.dataDir,
    now: o.now,
  });
  return { mon, shell, logs, pods, changes: () => changes };
}

describe("ResourceMonitor", () => {
  test("machine and pod figures, matched by uid; shared images counted once", async () => {
    const { mon } = monitor();
    await mon.runFast(vps);
    await mon.runSlow(vps);
    const m = mon.machine("m-vps")!;
    expect(m.os).toBe("Linux");
    expect(m.mem).toEqual({ total: 16303212 * 1024, available: 11954232 * 1024 });
    expect(m.disk).toEqual({
      path: "/var/lib/docker",
      total: 479595076 * 1024,
      free: 120654848 * 1024,
    });
    // Only Panem's pods (default-ot-xy isn't one): RAM 255.7 MiB (omni-b has no stats line).
    expect(m.pods!.mem).toBe(Math.round(255.7 * MiB));
    // Writable layers + own DinD volumes: 1.15 GB + 2 GB + 200 MB + 500 MB.
    expect(m.pods!.storage).toBe(1_150_000_000 + 2_000_000_000 + 200_000_000 + 500_000_000);
    // Both Panem pods use one image (3.13 GB - 1.15 GB), counted once.
    expect(m.sharedImages).toBe(1_980_000_000);
    // Unused DinD volumes; npm-cache isn't one.
    expect(m.orphans).toEqual({ count: 2, bytes: 4_000_000_000 });
    expect(m.low).toEqual({ mem: false, disk: false });

    expect(mon.pod({ id: "omni-a", machine: "m-vps", uid: "default-om-ab" })).toMatchObject({
      mem: Math.round(255.7 * MiB),
      writable: 1_150_000_000,
      dind: 2_000_000_000,
    });
    expect(mon.pod({ id: "omni-x", machine: "m-vps" })).toBeUndefined();
    expect(mon.dindOf("m-vps", "default-om-ab")).toEqual(["dind-var-lib-docker-default-om-ab"]);
  });

  test("low: under the percentage or under the absolute amount", async () => {
    const pct = monitor({ thresholds: { lowMemPercent: 80, lowDiskBytes: 200 * 1000 ** 3 } });
    await pct.mon.runFast(vps);
    await pct.mon.runSlow(vps);
    // 11.4 of 15.5 GiB available is 73% (< 80%); 123 GB free disk is under 200 GB.
    expect(pct.mon.machine("m-vps")!.low).toEqual({ mem: true, disk: true });
    const bytes = monitor({ thresholds: { lowMemBytes: 12 * GiB } });
    await bytes.mon.runFast(vps);
    expect(bytes.mon.machine("m-vps")!.low!.mem).toBe(true);
  });

  test("a run is skipped while the last one is still going", async () => {
    const shell = new FakeShell();
    shell.delay = 50;
    const { mon } = monitor({ shell });
    await Promise.all([mon.runFast(vps), mon.runFast(vps), mon.runSlow(vps), mon.runSlow(vps)]);
    expect(shell.calls.filter((c) => c === "fast")).toHaveLength(1);
    expect(shell.calls.filter((c) => c === "slow")).toHaveLength(1);
  });

  test("a slow storage run backs off for 5 minutes", async () => {
    let t = 0;
    const shell = new FakeShell();
    const { mon, logs } = monitor({ shell, now: () => t });
    shell.onRun = () => {
      t += 12_000; // each run takes 12 s
    };
    await mon.runSlow(vps);
    expect(logs.some((l) => l.includes("next in 5 minutes"))).toBe(true);
    await mon.runSlow(vps);
    expect(shell.calls.filter((c) => c === "slow")).toHaveLength(1);
    t += SLOW_BACKOFF_MS;
    await mon.runSlow(vps);
    expect(shell.calls.filter((c) => c === "slow")).toHaveLength(2);
  });

  test("a failure keeps the last numbers, marked stale, and logs once", async () => {
    const { mon, shell, logs } = monitor();
    await mon.runFast(vps);
    shell.fail = true;
    await mon.runFast(vps);
    await mon.runFast(vps);
    const m = mon.machine("m-vps")!;
    expect(m.mem?.total).toBe(16303212 * 1024);
    expect(m.stale).toBe(true);
    expect(m.error).toContain("timed out");
    expect(logs.filter((l) => l.includes("couldn't read resource usage"))).toHaveLength(1);
  });

  test("macOS: no RAM figure rather than a wrong one", async () => {
    const shell = new FakeShell();
    shell.fast = "@@panem:os\nDarwin\n@@panem:mem\n@@panem:pods\n@@panem:stats\n";
    const { mon } = monitor({ shell });
    await mon.runFast(vps);
    const m = mon.machine("m-vps")!;
    expect(m.os).toBe("Darwin");
    expect(m.mem).toBeUndefined();
  });
});

describe("DinD volumes", () => {
  test("a pod's volume is read from its container's mounts, not built from its uid", async () => {
    const { mon } = monitor();
    expect(await mon.podVolumes(vps, "default-om-ab")).toEqual([
      "dind-var-lib-docker-default-om-ab",
    ]);
  });

  test("removed when unused; kept and retried later when not, across restarts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "panem-res-"));
    const shell = new FakeShell();
    shell.inUse.add("dind-var-lib-docker-default-om-ab");
    const { mon } = monitor({ shell, dataDir });
    expect(await mon.removeVolumes(vps, ["dind-var-lib-docker-default-om-ab", "dind-x"])).toEqual({
      removed: ["dind-x"],
      kept: ["dind-var-lib-docker-default-om-ab"],
    });
    expect(JSON.parse(readFileSync(join(dataDir, "pending-volumes.json"), "utf8"))).toEqual({
      "m-vps": ["dind-var-lib-docker-default-om-ab"],
    });
    // A new controller process picks the list up; the next storage run removes it.
    shell.inUse.clear();
    const again = monitor({ shell, dataDir });
    await again.mon.runSlow(vps);
    expect(shell.removed).toContain("dind-var-lib-docker-default-om-ab");
    expect(again.mon.pendingFor("m-vps")).toEqual([]);
  });

  test("queued removals (force delete, machine offline) happen on the next run", async () => {
    const { mon, shell } = monitor();
    await mon.queueRemoval("m-vps", ["dind-var-lib-docker-default-om-zz", "bad name;rm -rf"]);
    expect(mon.pendingFor("m-vps")).toEqual(["dind-var-lib-docker-default-om-zz"]);
    await mon.runSlow(vps);
    expect(shell.removed).toEqual(["dind-var-lib-docker-default-om-zz"]);
  });

  test("prune: only unused DinD volumes nobody recorded; re-checked before removal", async () => {
    const { mon, shell, pods } = monitor();
    pods.push({
      id: "omni-c",
      machine: "m-vps",
      uid: "u",
      volumes: ["dind-var-lib-docker-default-old2"],
    });
    expect(await mon.orphans(vps)).toEqual([
      { name: "dind-var-lib-docker-default-old1", size: 3_000_000_000 },
    ]);
    shell.inUse.add("dind-var-lib-docker-default-old1"); // mounted since it was listed
    const r = await mon.prune(vps, [
      "dind-var-lib-docker-default-old1",
      "dind-var-lib-docker-default-old2",
      "npm-cache",
    ]);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([
      { name: "dind-var-lib-docker-default-old1", reason: "in use by a container" },
      { name: "dind-var-lib-docker-default-old2", reason: "belongs to a pod" },
      { name: "npm-cache", reason: "not a Docker-in-Docker volume" },
    ]);
    shell.inUse.clear();
    const ok = await mon.prune(vps, ["dind-var-lib-docker-default-old1"]);
    expect(ok.removed).toEqual([{ name: "dind-var-lib-docker-default-old1", size: 3_000_000_000 }]);
  });

  test("the scripts' sections split cleanly", () => {
    const s = sections("junk\n@@panem:a\n1\n2\n@@panem:b\n\n");
    expect([...s.keys()]).toEqual(["a", "b"]);
    expect(s.get("a")).toBe("1\n2\n");
  });
});
