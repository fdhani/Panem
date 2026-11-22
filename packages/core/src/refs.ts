import { z } from "zod";

/** Git ref: branch, tag, or commit. Rejects anything that could become a CLI flag. */
export const GitRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "invalid git ref")
  .refine((r) => !r.startsWith("-") && !r.includes(".."), "invalid git ref");
