import type { Forwarder } from "./forwarder";

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

/** Control API the controller polls: GET /state, DELETE /pods/:id. Bearer token required. */
export function controlHandler(fwd: Forwarder, token: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const auth = req.headers.get("authorization") ?? "";
    if (!safeEqual(auth.replace(/^Bearer /, ""), token) || !auth.startsWith("Bearer ")) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (req.method === "GET" && url.pathname === "/state") return Response.json(fwd.state());
    const m = url.pathname.match(/^\/pods\/([a-z0-9-]{1,64})$/);
    if (req.method === "DELETE" && m) {
      return Response.json({ released: await fwd.release(m[1]!) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}
