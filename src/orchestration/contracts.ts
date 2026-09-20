// Pinned shared contracts for agent-orchestration Phase 0.
// Owned by no unit — units implement AGAINST this. Design: claude-notes/sushii-agent/tasks/agent-orchestration.
import { z } from "zod";

// ── Task status (see ARCHITECTURE.md "Two loops"). needs_input is reserved for Phase 4. ──
export const TASK_STATUSES = ["running", "idle", "needs_input", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ── Registry row (U0.2 implements the Drizzle table to match this shape). ──
// id is a registry ULID, distinct from the runner's native session id.
export interface TaskRow {
  id: string;
  createdBy: string; // principal id (P0: the owner)
  runnerId: string;
  project: string | null;
  cwd: string | null; // task working directory — persisted so resume() runs in the right place
  nativeSessionId: string | null; // runner's own session id (e.g. Claude Code UUID)
  resumeCursor: string | null;
  status: TaskStatus;
  statusReason: string | null;
  summary: string | null; // last authored handback recap
  spawnedFromSurface: string; // provenance only
  threadRefs: string[]; // JSON-encoded in SQLite
  createdAt: number; // unix seconds
  updatedAt: number;
}

// ── Runner → orchestrator events (pushed over the WS). ──
export type RunnerEvent =
  | { kind: "status"; taskId: string; status: TaskStatus; reason?: string }
  | { kind: "progress"; taskId: string; note: string } // debounced; never per-token
  | { kind: "handback"; taskId: string; summary: string; meta?: HandbackMeta };

// Deterministic, LLM-free metadata the runner computes (git + result object).
export interface HandbackMeta {
  filesChanged?: number;
  commits?: number;
  testsPassed?: boolean;
  toolsRun?: number;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  denials?: number; // tool calls the permission mode auto-denied — a "success" with denials > 0 is incomplete
}

// ── Runner adapter interface (uniform across kinds; P0 = Claude Code only). ──
export interface RunnerAdapter {
  start(input: { taskId: string; cwd: string; prompt: string }): Promise<{ nativeSessionId: string }>;
  resume(input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string }): Promise<void>;
  interrupt(taskId: string): Promise<void>;
  // Emits RunnerEvents for the task; implementation streams via the callback.
  stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void>;
}

// ── Wire protocol: JSON-RPC 2.0 over WebSocket. Verbs borrow ACP vocabulary. ──
export const RPC_METHODS = {
  register: "runner/register", // runner → orchestrator on connect
  start: "session/new",
  resume: "session/resume",
  interrupt: "session/cancel",
  event: "session/update", // runner → orchestrator notification (carries RunnerEvent)
  heartbeat: "runner/heartbeat", // runner → orchestrator keep-alive notification (resets the WS idle timer)
} as const;

export const jsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export const jsonRpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});
export const jsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequest>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotification>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponse>;

export const registerParams = z.object({
  runnerId: z.string(),
  kind: z.string(), // "claude-code" | "mock" | ...
  projects: z.array(z.string()).default([]),
});
export type RegisterParams = z.infer<typeof registerParams>;

// ── Authz seam (P0 stub = owner-only AND a hardcoded personal/DM-space allowlist). ──
// Real tables land in Phase 2 (U2.1). Keep this signature stable so the swap is drop-in.
export type Capability = "runner.dispatch" | "session.read" | "session.resume" | "session.interrupt";
export interface AuthzInput {
  principal: string;
  capability: Capability;
  resource?: string; // e.g. runnerId or taskId
  space: string; // surface+scope key the request arrived in
}
export type CanFn = (input: AuthzInput) => boolean;
