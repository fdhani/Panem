import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}${req.method === "POST" ? ` ${await req.text()}` : ""}`);
    if (u.pathname === "/api/machines/m-homeserver/orphans") {
      return Response.json([
        { name: "dind-var-lib-docker-default-old-a", size: 3_400_000_000 },
        { name: "dind-var-lib-docker-default-old-b", size: 820_000_000 },
      ]);
    }
    if (u.pathname === "/api/machines/m-homeserver/prune") {
      return Response.json({
        removed: [{ name: "dind-var-lib-docker-default-old-a", size: 3_400_000_000 }],
        skipped: [{ name: "dind-var-lib-docker-default-old-b", reason: "in use by a container" }],
      });
    }
    return new Response(null, { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function prune(stdin: string, ...args: string[]) {
  const p = Bun.spawn(["bun", main, "machine", "prune", "homeserver", ...args], {
    env: { ...process.env, PANEM_URL: `http://localhost:${server.port}`, PANEM_TOKEN: "t" },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await p.exited).toBe(0);
  return (await new Response(p.stdout).text()).trim();
}

test("machine prune lists sizes and deletes nothing unless told yes", async () => {
  const no = await prune("n\n");
  expect(no).toContain("dind-var-lib-docker-default-old-a  3.40GB");
  expect(no).toContain("2 unused volume(s), 4.22GB in all.");
  expect(no).toContain("Nothing deleted.");
  expect(seen.some((s) => s.startsWith("POST"))).toBe(false);

  const yes = await prune("y\n");
  expect(yes).toContain("Deleted 1 volume(s), freeing 3.40GB.");
  expect(yes).toContain("Kept dind-var-lib-docker-default-old-b: in use by a container");
  expect(seen.filter((s) => s.startsWith("POST"))).toEqual([
    'POST /api/machines/m-homeserver/prune {"volumes":["dind-var-lib-docker-default-old-a","dind-var-lib-docker-default-old-b"]}',
  ]);
});
