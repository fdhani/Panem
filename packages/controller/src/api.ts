import { AddMachineRequest, PortNumber, SetPortExposure, SummonRequest } from "@panem/core";
import { BackendError } from "@panem/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { HttpError, type PodService, msg } from "./service";
import type { Templates } from "./templates";

export interface ApiDeps {
  service: PodService;
  templates: Templates;
  apiToken: string;
  /** Static UI assets: path -> Blob. Missing means API-only. */
  ui?: Map<string, Blob>;
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

async function body<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return r.data;
}

export function createApp(d: ApiDeps): Hono {
  const app = new Hono();
  const { service } = d;

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof BackendError) return c.json({ error: err.message }, 502);
    console.error(err);
    return c.json({ error: msg(err) }, 500);
  });

  app.get("/healthz", (c) => c.text("ok"));

  // Bearer token on every API route. EventSource can't set headers, so SSE also accepts ?token=.
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : c.req.path === "/api/events"
        ? (c.req.query("token") ?? "")
        : "";
    if (!safeEqual(token, d.apiToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/machines", (c) => c.json(service.machines()));
  app.post("/api/machines", async (c) =>
    c.json(await service.addMachine(await body(c.req.raw, AddMachineRequest)), 201),
  );
  app.delete("/api/machines/:name", async (c) => {
    await service.removeMachine(c.req.param("name"));
    return c.body(null, 204);
  });

  app.post("/api/machines/:name/repair", async (c) =>
    c.json(await service.repairMachine(c.req.param("name"))),
  );

  app.get("/api/templates", async (c) => c.json(await d.templates.list()));

  app.get("/api/pods", (c) => c.json(service.podList()));
  app.get("/api/pods/:id", (c) => c.json(service.get(c.req.param("id"))));
  app.post("/api/pods", async (c) =>
    c.json(await service.summon(await body(c.req.raw, SummonRequest)), 202),
  );
  app.post("/api/pods/:id/stop", async (c) => c.json(await service.stop(c.req.param("id")), 202));
  app.post("/api/pods/:id/start", async (c) => c.json(await service.start(c.req.param("id")), 202));
  app.put("/api/pods/:id/ports/:port", async (c) => {
    const port = PortNumber.safeParse(c.req.param("port"));
    if (!port.success) throw new HttpError(400, "invalid port");
    const { exposed } = await body(c.req.raw, SetPortExposure);
    return c.json(await service.setPortExposure(c.req.param("id"), port.data, exposed));
  });
  app.post("/api/pods/:id/retry-export", async (c) => {
    const pod = await service.retryExport(c.req.param("id"));
    return c.json(pod ?? null, 202);
  });
  app.delete("/api/pods/:id", async (c) => {
    const force = c.req.query("force") === "true";
    const pod = await service.delete(c.req.param("id"), force);
    return pod ? c.json(pod, 202) : c.body(null, 204);
  });
  app.post("/api/rediscover", async (c) => c.json(await service.rediscover()));

  app.get("/api/jobs", (c) => c.json(service.snapshot().find((e) => e.type === "jobs")));

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const unsub = service.subscribe((e) => {
        queue.push(JSON.stringify(e));
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      for (const e of service.snapshot()) queue.push(JSON.stringify(e));
      while (!stream.aborted) {
        while (queue.length) await stream.writeSSE({ data: queue.shift()! });
        await Promise.race([
          new Promise<void>((r) => {
            wake = r;
          }),
          stream.sleep(25_000),
        ]);
        wake = undefined;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      unsub();
    }),
  );

  // ---- static UI (SPA fallback to index.html) ----
  app.get("*", (c) => {
    if (!d.ui || d.ui.size === 0) return c.text("panem controller (UI not bundled)", 404);
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const asset = d.ui.get(path) ?? d.ui.get("/index.html")!;
    const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(asset, { headers: { "cache-control": cache, "content-type": asset.type } });
  });

  return app;
}
