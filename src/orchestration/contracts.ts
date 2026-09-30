// Wire contracts between the bot and the personal-agent workspace.
import { z } from "zod";

// ── Wire protocol: JSON-RPC 2.0 over WebSocket. Verbs borrow ACP vocabulary. ──
export const RPC_METHODS = {
  // The "runner/" prefix is historical; renaming it would break a workspace and bot on different versions.
  register: "runner/register", // workspace → bot on connect
  heartbeat: "runner/heartbeat", // workspace → bot keep-alive notification (resets the WS idle timer)
  // Personal-agent chat verbs (role "workspace"). Bot → workspace requests:
  chatMessage: "chat/message",
  chatAbort: "chat/abort",
  chatNew: "chat/new",
  chatAck: "chat/ack",
  // Owner commands the workspace answers itself (!compact, !model, !tasks) → { text }.
  chatCommand: "chat/command",
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

export const CHAT_COMMANDS = ["compact", "model", "tasks"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];
export const chatCommandParams = z.object({ principalId: z.string(), command: z.enum(CHAT_COMMANDS), args: z.string().max(200).optional() });
export type ChatCommandParams = z.infer<typeof chatCommandParams>;
export interface ChatCommandResult {
  text: string;
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
// `retry`: the paste was turned away before reaching the login, which is still pending.
export type AuthCompleteResult = { ok: true; model?: string } | { ok: false; error: string; inactive?: true; retry?: true };

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

export const CONNECTION_ROLES = ["workspace"] as const;
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];
// WebSocket close codes the orchestrator uses to reject or evict a registration.
export const ORCH_CLOSE = {
  unauthorized: 4401,
  replaced: 4409,
  unsupportedVersion: 4426,
} as const;

// Unknown keys (projects, workspaceRoot, ... from older clients) are stripped, not rejected.
export const registerParams = z.object({
  runnerId: z.string(),
  kind: z.string(), // e.g. "pi-workspace"
  // Required, with no default: a legacy task runner omits it and must fail the parse.
  role: z.enum(CONNECTION_ROLES),
  protocolVersion: z.number().int().default(1),
  secret: z.string().optional(),
  // Assertion only: must match the principal the secret maps to.
  principalId: z.string().optional(),
  state: z.enum(["idle", "streaming"]).optional(),
});
export type RegisterParams = z.infer<typeof registerParams>;
