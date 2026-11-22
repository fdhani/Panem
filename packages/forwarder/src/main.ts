#!/usr/bin/env bun
// Entry point of the panem-forwarder container. Configured entirely through env.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PANEM_VERSION, RELAY_PORT } from "@panem/core";
import { Allocator } from "./alloc";
import { controlHandler } from "./api";
import { DockerClient } from "./docker";
import { Forwarder } from "./forwarder";

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 16) {
    console.error(`[forwarder] ${name} must be set (16+ chars)`);
    process.exit(2);
  }
  return v;
}

const token = need("PANEM_FORWARDER_TOKEN");
const secret = need("PANEM_RELAY_SECRET");
const [lo, hi] = (process.env.PANEM_PORT_RANGE ?? "7600-7699").split("-").map(Number) as [
  number,
  number,
];
const blockSize = Number(process.env.PANEM_BLOCK_SIZE ?? 10);
const controlPort = Number(process.env.PANEM_CONTROL_PORT ?? 7599);
const bindHost = process.env.PANEM_BIND ?? "0.0.0.0";
const dataDir = process.env.PANEM_DATA ?? "/data";
const inDocker = existsSync("/.dockerenv");

const alloc = new Allocator([lo, hi], blockSize, join(dataDir, "assignments.json"));
await alloc.load();
const fwd = new Forwarder({
  docker: new DockerClient(process.env.DOCKER_SOCKET),
  alloc,
  secret,
  blockSize,
  bindHost,
  relayPort: Number(process.env.PANEM_RELAY_PORT ?? RELAY_PORT),
  selfId: inDocker ? process.env.HOSTNAME : undefined,
});

Bun.serve({ hostname: bindHost, port: controlPort, fetch: controlHandler(fwd, token) });
console.log(
  `[forwarder] ${PANEM_VERSION} control on :${controlPort}, ports ${lo}-${hi} in blocks of ${blockSize}`,
);

const loop = async () => {
  try {
    await fwd.tick();
  } catch (e) {
    console.warn(`[forwarder] tick failed: ${e instanceof Error ? e.message : e}`);
  }
  setTimeout(loop, 3000);
};
loop();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    fwd.stop();
    process.exit(0);
  });
}
