import { z } from "zod";

export const SESSION_TEXT_MAX = 16_000;
export const SESSION_FILES_MAX = 24;
const contextFile = z.object({
  path: z.string().max(512),
  content: z.string().max(SESSION_TEXT_MAX),
  truncated: z.boolean(),
});
export const sessionBoundary = z.object({
  kind: z.enum(["new", "rotated", "compacted"]),
  summary: z.string().max(SESSION_TEXT_MAX).optional(),
  summaryTruncated: z.boolean().optional(),
  memory: z.object({
    files: z.array(contextFile.extend({ change: z.enum(["added", "changed", "removed"]) })).max(SESSION_FILES_MAX),
    truncated: z.boolean(),
  }).optional(),
  context: z.object({ files: z.array(contextFile).max(SESSION_FILES_MAX), truncated: z.boolean() }).optional(),
  initialContext: z.string().max(SESSION_TEXT_MAX).optional(),
});
export type SessionBoundary = z.infer<typeof sessionBoundary>;
