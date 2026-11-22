import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    return new Response(null, { status: 204 });
  },
});
afterAll(() => server.stop(true));

async function rm(...args: string[]) {
  const p = Bun.spawn(["bun", main, "pod", "rm", "p1", ...args], {
    env: { ...process.env, PANEM_URL: `http://localhost:${server.port}`, PANEM_TOKEN: "t" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await p.exited).toBe(0);
  return (await new Response(p.stdout).text()).trim();
}

test("pod rm: hooks always run; --no-memory skips only the memory save; --force skips both", async () => {
  expect(await rm()).toBe("saving memory and deleting p1");
  expect(await rm("--no-memory")).toBe("deleting p1 without saving memory");
  expect(await rm("--force")).toBe("deleted p1");
  expect(seen).toEqual([
    "DELETE /api/pods/p1",
    "DELETE /api/pods/p1?memory=false",
    "DELETE /api/pods/p1?force=true",
  ]);
});
