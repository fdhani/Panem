import { configPath, loadConfig } from "@panem/core";

export interface Client {
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** API client. Uses PANEM_URL/PANEM_TOKEN, else the local controller's config. */
export async function client(): Promise<Client> {
  let url = process.env.PANEM_URL;
  let token = process.env.PANEM_TOKEN;
  if (!url || !token) {
    const cfg = await loadConfig().catch(() => undefined);
    if (!cfg && !token) {
      throw new Error(`set PANEM_URL and PANEM_TOKEN, or run on the controller (${configPath()})`);
    }
    url ??= `http://127.0.0.1:${cfg?.port ?? 7420}`;
    token ??= cfg?.apiToken;
  }
  return {
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 204) return undefined as T;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
      return data as T;
    },
  };
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
