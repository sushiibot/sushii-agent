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
  archivedAt: number | null; // unix seconds; set when the task ages out of the live roster (still resumable)
}

// ── Runner → orchestrator events (pushed over the WS). ──
export type RunnerEvent =
  | { kind: "status"; taskId: string; status: TaskStatus; reason?: string }
  | { kind: "progress"; taskId: string; note: string } // debounced; never per-token
  // One granular activity line, typed so surfaces can filter: "tool" (a call + its args), "result"
  // (a tool's output — hidden by default, revealed on demand), "text" (assistant text). Feeds the
  // live views; not debounced at the source.
  | { kind: "activity"; taskId: string; line: string; at: number; atype: "tool" | "result" | "text" }
  // The agent is blocked and asking the owner (ask_owner tool). The task pauses at needs_input until an
  // answer is routed back (via the steer channel). choices, when present, are offered as buttons.
  | { kind: "ask"; taskId: string; askId: string; question: string; choices?: string[] }
  // Agent-initiated, non-blocking owner message. The orchestrator persists and delivers it separately
  // from task control; it never steers or pauses the task.
  | { kind: "owner_message"; taskId: string; messageId: string; text: string }
  | { kind: "handback"; taskId: string; summary: string; meta?: HandbackMeta }
  // Live browser view, only sent while a viewer watches (see RPC_METHODS.browserWatch). Every field
  // but taskId is optional: a message carries a new frame, a navigation, or a state change.
  | { kind: "browser"; taskId: string } & BrowserUpdate;

export interface BrowserUpdate {
  supported?: boolean; // false = this runner has no browser
  connected?: boolean; // a browser is open for the task
  frame?: string; // base64 JPEG of the viewport
  width?: number;
  height?: number;
  url?: string;
  title?: string;
}

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
  branch?: string; // runner-pushed task branch (clone-on-demand)
  prUrl?: string; // PR the runner opened at handback
}

// A repo the orchestrator asks a runner to clone on-demand into its workspace before running.
export interface RepoSpec {
  owner: string;
  repo: string;
}

// ── Runner adapter interface (uniform across kinds; P0 = Claude Code only). ──
export interface RunnerAdapter {
  // repo (optional) = clone-on-demand: the runner clones owner/repo into `cwd` if absent before the
  // agent runs, and pushes a branch + opens a PR at handback. Adapters without a token provider
  // ignore it and assume `cwd` is already a checkout.
  start(input: { taskId: string; cwd: string; prompt: string; repo?: RepoSpec | null }): Promise<{ nativeSessionId: string }>;
  resume(input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string }): Promise<void>;
  interrupt(taskId: string): Promise<void>;
  // Halt the active run but leave the task resumable (session file kept). `discard` also removes a
  // clone-on-demand worktree — never a caller-supplied project dir. Unlike interrupt, stop must NOT
  // surface a "failed" status for the halted run (the dispatcher records idle/terminal itself).
  stop(input: { taskId: string; discard?: boolean }): Promise<void>;
  // Live-steer a RUNNING session (mid-turn injection, no abort). Returns delivered:false when there is
  // no live session to inject into (task not running, or the runner kind is one-shot) — the caller then
  // falls back to resume. Adapters that can't inject always return delivered:false.
  steer(input: { taskId: string; text: string }): Promise<{ delivered: boolean }>;
  // Append an ordinary user follow-up without superseding/cancelling the active turn. False means
  // the runner cannot safely accept it live; an idle task may instead be resumed by the dispatcher.
  followUp(input: { taskId: string; text: string }): Promise<{ delivered: boolean }>;
  // Start/stop relaying the task's live browser view as "browser" events. Optional: kinds without a
  // browser omit it and the client answers supported:false.
  watchBrowser?(input: { taskId: string; watch: boolean }): Promise<{ supported: boolean }>;
  // Emits RunnerEvents for the task; implementation streams via the callback.
  stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void>;
}

// ── Wire protocol: JSON-RPC 2.0 over WebSocket. Verbs borrow ACP vocabulary. ──
export const RPC_METHODS = {
  register: "runner/register", // runner → orchestrator on connect
  start: "session/new",
  resume: "session/resume",
  interrupt: "session/cancel",
  stop: "session/stop", // halt but keep resumable (params: { taskId, discard? })
  message: "session/message", // live steer into a running session (params: { taskId, text }) → { delivered }
  followUp: "session/follow-up", // append an ordinary inbound message; never supersedes the current turn
  event: "session/update", // runner → orchestrator notification (carries RunnerEvent)
  browserWatch: "session/browser", // start/stop the live browser relay (params: { taskId, watch }) → { supported }
  heartbeat: "runner/heartbeat", // runner → orchestrator keep-alive notification (resets the WS idle timer)
  // Personal-agent chat verbs (role "workspace"). Bot → workspace requests:
  chatMessage: "chat/message",
  chatAbort: "chat/abort",
  chatNew: "chat/new",
  chatAck: "chat/ack",
  // Workspace → bot: deliver is a request (bot replies {} then later sends chat/ack); event is a notification.
  chatDeliver: "chat/deliver",
  chatEvent: "chat/event",
  // Workspace → bot request: run one of the bot's secret-holding tools (manifest sent in the register result).
  toolCall: "tool/call",
  // Workspace → bot request: withdraw a still-pending tool/call (its turn was stopped) → { cancelled }.
  toolCancel: "tool/cancel",
} as const;

// ── Chat protocol (workspace ↔ bot). ──
// Where a chat message came from; replies/events echo it so the bot routes them back to that surface.
// Optional on deliver/event: a proactive message has none, and neither do entries outboxed before origins.
export const chatOrigin = z.object({ surface: z.string(), conversationId: z.string() });
export type ChatOrigin = z.infer<typeof chatOrigin>;

export const chatMessageParams = z.object({
  origin: chatOrigin,
  principalId: z.string(),
  messageId: z.string(),
  text: z.string(),
  kind: z.enum(["user", "context"]),
  author: z.object({ id: z.string(), name: z.string() }),
  attachments: z.array(z.object({ url: z.string(), name: z.string(), contentType: z.string() })).optional(),
  voice: z.boolean().optional(),
});
export type ChatMessageParams = z.infer<typeof chatMessageParams>;
export type ChatMessageMode = "prompt" | "steer" | "duplicate" | "context";
export interface ChatMessageResult {
  accepted: true;
  mode: ChatMessageMode;
}

// With turnId, only that turn is aborted; a stale Stop from a finished turn is a no-op.
export const chatAbortParams = z.object({ principalId: z.string(), turnId: z.string().optional() });
export type ChatAbortParams = z.infer<typeof chatAbortParams>;
export interface ChatAbortResult {
  aborted: boolean;
}

export const chatNewParams = z.object({ principalId: z.string() });
export type ChatNewParams = z.infer<typeof chatNewParams>;
export interface ChatNewResult {
  sessionFile: string;
}

export const chatAckParams = z.object({ outboxId: z.string() });
export type ChatAckParams = z.infer<typeof chatAckParams>;

export const chatUsage = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  costUsd: z.number().optional(),
  contextPct: z.number().optional(),
});
export type ChatUsage = z.infer<typeof chatUsage>;

// Bound on workspace-chosen ids and names, so one can't bloat a log line or a Discord component.
export const ID_MAX = 256;

export const chatDeliverParams = z.object({
  origin: chatOrigin.optional(),
  outboxId: z.string(),
  principalId: z.string(),
  kind: z.enum(["reply", "proactive", "ask", "auth"]),
  text: z.string(),
  replyTo: z.string().optional(),
  turnId: z.string().optional(),
  usage: chatUsage.optional(),
  ask: z.object({ askId: z.string(), question: z.string(), choices: z.array(z.string()).optional() }).optional(),
  // kind "auth": a sign-in link to open.
  auth: z.object({ url: z.string().url().max(4096), instructions: z.string() }).optional(),
  // Set on the reply that ends a surface login, so the bot stops treating pastes as its callback.
  authResult: z.enum(["ok", "failed", "cancelled", "timeout"]).optional(),
  // kind "auth" and authResult: the login they belong to, so a resent result can't end a newer login.
  loginId: z.string().max(ID_MAX).optional(),
});
export type ChatDeliverParams = z.infer<typeof chatDeliverParams>;

export const chatEventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("tool_start"), name: z.string(), summary: z.string() }),
  z.object({ type: z.literal("tool_end"), name: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("turn_end"), aborted: z.boolean() }),
]);
export type ChatEventPayload = z.infer<typeof chatEventPayload>;

export const chatEventParams = z.object({
  origin: chatOrigin.optional(),
  principalId: z.string(),
  turnId: z.string(),
  agentId: z.string().min(1).max(ID_MAX), // "main" | <runId> of a subagent
  parentRunId: z.string().optional(),
  ev: chatEventPayload,
});
export type ChatEventParams = z.infer<typeof chatEventParams>;

// ── ChatGPT sign-in from a chat surface (bot → workspace requests). ──
// The workspace answers auth/start, then sends the sign-in link as chat/deliver kind "auth" and, when the
// login ends, a chat/deliver kind "reply" carrying authResult.
export const AUTH_METHODS = {
  start: "auth/start",
  complete: "auth/complete",
  cancel: "auth/cancel",
} as const;

/** auth/start's error message when a login is already running. */
export const LOGIN_ALREADY_PENDING = "a ChatGPT sign-in is already in progress";

export const authStartParams = z.object({ principalId: z.string(), provider: z.literal("openai"), origin: chatOrigin });
export type AuthStartParams = z.infer<typeof authStartParams>;
export interface AuthStartResult {
  started: true;
  loginId: string;
}

/** `input` is the pasted callback URL; it carries the authorization code, so it is never logged. */
export const authCompleteParams = z.object({ principalId: z.string(), input: z.string().max(8192) });
export type AuthCompleteParams = z.infer<typeof authCompleteParams>;
/** `inactive`: no login was running, so no result delivery follows. */
export type AuthCompleteResult = { ok: true; model?: string } | { ok: false; error: string; inactive?: true };

export const authCancelParams = z.object({ principalId: z.string() });
export type AuthCancelParams = z.infer<typeof authCancelParams>;
export interface AuthCancelResult {
  cancelled: boolean;
}

// ── Bot-proxied tools (workspace → bot). ──
export const TOOL_APPROVALS = ["none", "ask"] as const;
export type ToolApproval = (typeof TOOL_APPROVALS)[number];

export const toolManifestEntry = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()), // JSON Schema (draft 7 subset)
  approval: z.enum(TOOL_APPROVALS),
});
export type ToolManifestEntry = z.infer<typeof toolManifestEntry>;

/** The register result a `role: "workspace"` connection receives. */
export const workspaceRegisterResult = z.object({ ok: z.literal(true), tools: z.array(toolManifestEntry) });
export type WorkspaceRegisterResult = z.infer<typeof workspaceRegisterResult>;

export const toolCallParams = z.object({
  principalId: z.string().max(ID_MAX),
  callId: z.string().min(1).max(ID_MAX),
  name: z.string().max(ID_MAX),
  args: z.unknown(),
  agentId: z.string().min(1).max(ID_MAX), // "main" | <runId>
  agentName: z.string().max(ID_MAX),
  parentRunId: z.string().max(ID_MAX).optional(),
});
export type ToolCallParams = z.infer<typeof toolCallParams>;
export type ToolCallResult = { ok: true; result: string } | { ok: false; error: string; denied?: boolean };

export const toolCancelParams = z.object({
  principalId: z.string().max(ID_MAX),
  callId: z.string().min(1).max(ID_MAX),
});
export type ToolCancelParams = z.infer<typeof toolCancelParams>;
/** cancelled is false when the call already finished, is unknown, or is already executing. */
export type ToolCancelResult = { cancelled: boolean };

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

export const CONNECTION_ROLES = ["workspace", "task-runner"] as const;
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];
// WebSocket close codes the orchestrator uses to reject or evict a registration.
export const ORCH_CLOSE = {
  unauthorized: 4401,
  replaced: 4409,
  unsupportedVersion: 4426,
} as const;

export const registerParams = z.object({
  runnerId: z.string(),
  kind: z.string(), // "claude-code" | "mock" | ...
  projects: z.array(z.string()).default([]),
  // Absolute dir this runner clones on-demand repos into (clone-on-demand). Declaring it engages
  // the dispatch scope fence even when `projects` is empty, and lets the orchestrator derive a
  // clone cwd under it. null = runner does no clone-on-demand.
  workspaceRoot: z.string().nullable().default(null),
  // Human-friendly location for display (e.g. "apps · container", "drk-wsl2 · desktop"). Optional.
  location: z.string().nullable().default(null),
  // What the runner's agent can do beyond coding, e.g. "browser" (headless Chromium via agent-browser).
  capabilities: z.array(z.string()).default([]),
  // A personal runner: the orchestrator only lets the owner dispatch to it.
  ownerOnly: z.boolean().default(false),
  // Absent on legacy runners, which are all task runners speaking v1.
  role: z.enum(CONNECTION_ROLES).default("task-runner"),
  protocolVersion: z.number().int().default(1),
  secret: z.string().optional(),
  // Assertion only: must match the principal the secret maps to.
  principalId: z.string().optional(),
  state: z.enum(["idle", "streaming"]).optional(),
});
export type RegisterParams = z.infer<typeof registerParams>;

// ── Authz seam (P0 stub = owner-only AND a hardcoded personal/DM-space allowlist). ──
// Real tables land in Phase 2 (U2.1). Keep this signature stable so the swap is drop-in.
export type Capability = "runner.dispatch" | "session.read" | "session.resume" | "session.interrupt" | "session.stop";
export interface AuthzInput {
  principal: string;
  capability: Capability;
  resource?: string; // e.g. runnerId or taskId
  space: string; // surface+scope key the request arrived in
  /** Whether the request arrived in a private/DM context. Required true for the configured-registry
   *  personal-space conjunction; ignored in the legacy regime. Callers populate it via ToolContext. */
  isPrivate?: boolean;
}
export type CanFn = (input: AuthzInput) => boolean;
