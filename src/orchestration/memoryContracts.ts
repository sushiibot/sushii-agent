import { z } from "zod";

export const MEMORY_FILE_MAX = 256 * 1024;
export const memoryParams = z.object({
  principalId: z.string().max(256),
  id: z.string().max(1024).optional(),
});
export const memoryFileSummary = z.object({
  id: z.string().max(1024),
  path: z.string().max(512),
  about: z.string().max(256),
  updatedAt: z.string().datetime(),
  lines: z.number().int().nonnegative(),
});
export const memoryOverview = z.object({
  files: z.array(memoryFileSummary).max(500),
  writes: z.array(z.unknown()).max(0),
  truncated: z.boolean(),
});
export const memoryDetail = z
  .object({
    file: memoryFileSummary.extend({
      content: z.string().max(MEMORY_FILE_MAX),
      truncated: z.boolean(),
    }),
    writes: z.array(z.unknown()).max(0),
  })
  .nullable();
