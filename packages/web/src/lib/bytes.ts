/**
 * Sizes as people compare them with their tools: RAM in binary units (GiB, like `free -h`),
 * disk in decimal ones (GB, like `df -H` and Docker).
 */
export function formatBytes(n: number | undefined, unit: "ram" | "disk" = "disk"): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  const base = unit === "ram" ? 1024 : 1000;
  const names = unit === "ram" ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "kB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= base && i < names.length - 1) {
    v /= base;
    i++;
  }
  const digits = i === 0 ? 0 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${names[i]}`;
}
