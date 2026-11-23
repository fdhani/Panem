// Overwritten by scripts/build.ts during `bun run build` to embed what Panem delivers to machines
// (the forwarder bundle and the devcontainer Features) into the compiled binary. Keep this stub
// committed: in dev and tests they're built from the repo's sources instead.
export const forwarderFile: string | undefined = undefined;
export const featureFiles: Record<string, { file: string; exec: boolean }> = {};
