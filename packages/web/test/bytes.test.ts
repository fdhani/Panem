import { expect, test } from "bun:test";
import { formatBytes } from "../src/lib/bytes";

test("RAM in binary units, disk in decimal ones; one decimal under 100", () => {
  expect(formatBytes(11954232 * 1024, "ram")).toBe("11.4 GiB");
  expect(formatBytes(16 * 1024 ** 3, "ram")).toBe("16.0 GiB");
  expect(formatBytes(Math.round(255.7 * 1024 ** 2), "ram")).toBe("256 MiB");
  expect(formatBytes(120654848 * 1024)).toBe("124 GB");
  expect(formatBytes(2_310_000_000)).toBe("2.3 GB");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(undefined)).toBe("–");
});
