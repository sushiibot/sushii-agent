import { z } from "zod";
import { TOPIC_ID_RE } from "./contracts.ts";

export const BROWSER_READ = "browser/read";
export const BROWSER_FRAME_MAX = 512 * 1024;
export const browserReadParams = z.object({
  principalId: z.string(), conversationId: z.string().regex(TOPIC_ID_RE),
  frames: z.boolean().default(false),
}).strict();
export const browserStatus = z.object({
  id: z.string().max(100), conversationId: z.string().regex(TOPIC_ID_RE),
  state: z.enum(["starting", "active", "ended"]),
  runId: z.string().max(100).nullable(),
  url: z.string().max(4096).optional(),
  action: z.string().max(100), endedAt: z.number().optional(),
}).strict();
export const browserFrame = z.object({
  seq: z.number().int().nonnegative(), data: z.string().max(BROWSER_FRAME_MAX).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
  capturedAt: z.number(),
}).strict();
export const browserReadResult = z.object({ status: browserStatus.nullable(), frame: browserFrame.optional() }).strict();
export type BrowserStatus = z.infer<typeof browserStatus>;
export type BrowserFrame = z.infer<typeof browserFrame>;
export type BrowserReadResult = z.infer<typeof browserReadResult>;
