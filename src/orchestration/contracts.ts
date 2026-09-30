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
  // Workspace → bot request: a short-lived GitHub App installation token for one repo.
  githubToken: "github/token",
  // Bot → workspace request: one page of the Main transcript, newest first.
  chatHistory: "chat/history",
  // Workspace → bot request: the bytes of an owner photo a chat/message referenced.
  uploadRead: "upload/read",
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
  // The origin surface can upload files a reply carries; without it send_file refuses rather than lose them.
  fileUploads: z.boolean().optional(),
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

// Outbound files. Deliveries travel as one WebSocket frame (Bun's default cap is 16 MiB), and base64 costs
// 4/3 of the raw bytes, so the per-delivery total stays well under that.
export const DELIVER_FILES_MAX = 10;
export const DELIVER_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const DELIVER_FILES_TOTAL_MAX_BYTES = 11 * 1024 * 1024;

/** Discord keeps only these characters in an attachment name; anything else would break `attachment://` references. */
export function discordAttachmentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-100) || "file";
}
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const base64Len = (bytes: number) => Math.ceil(bytes / 3) * 4;
/** Raw byte count of a padded base64 string. */
export function base64Bytes(b64: string): number {
  return (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

/** True only for an absolute URL whose parsed scheme is https: (the WHATWG parser strips tabs and newlines first). */
export function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

// ── Web chat (M1). ──
// The only conversation the web surface has; any other conversationId from the workspace is rejected.
export const WEB_CONVERSATION_ID = "main";
export const webConversationId = z.enum([WEB_CONVERSATION_ID]);
export const webChatOrigin = z.object({ surface: z.literal("web"), conversationId: webConversationId });
export type WebChatOrigin = z.infer<typeof webChatOrigin>;

/** Upload ids are 128-bit random base64url, issued by the bot. Lookups match this before touching the DB or disk. */
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const uploadId = z.string().regex(UPLOAD_ID_RE, "invalid upload id");
/** An owner photo in chat/message `attachments` is `upload:<id>`; the workspace fetches its bytes with upload/read. */
export const UPLOAD_URL_PREFIX = "upload:";
export function uploadUrl(id: string): string {
  return `${UPLOAD_URL_PREFIX}${id}`;
}
/** The upload id an `upload:<id>` attachment URL names, or null for anything else. */
export function parseUploadUrl(url: string): string | null {
  if (!url.startsWith(UPLOAD_URL_PREFIX)) return null;
  const id = url.slice(UPLOAD_URL_PREFIX.length);
  return UPLOAD_ID_RE.test(id) ? id : null;
}
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export const CHAT_HISTORY_TIMEOUT_MS = 15_000;
export const CHAT_HISTORY_LIMIT_MAX = 100;

export const chatHistoryParams = z.object({
  principalId: z.string(),
  // Opaque "<sessionFileBase>:<entryId>" cursor from a previous page; absent = newest.
  before: z.string().max(ID_MAX).optional(),
  limit: z.number().int().min(1).max(CHAT_HISTORY_LIMIT_MAX).default(40),
});
export type ChatHistoryParams = z.infer<typeof chatHistoryParams>;

const historyId = z.string().min(1).max(ID_MAX);
const historyAt = z.string().max(ID_MAX);
export const historyItem = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    id: historyId,
    clientId: historyId.optional(),
    at: historyAt,
    text: z.string(),
    attachments: z.array(z.object({ uploadId: uploadId.optional(), name: z.string().max(ID_MAX), contentType: z.string().max(ID_MAX) })),
  }),
  z.object({
    type: z.literal("assistant"),
    id: historyId,
    at: historyAt,
    text: z.string(),
    outboxId: historyId.optional(),
    turnId: historyId.optional(),
    tools: z.array(z.object({ name: z.string().max(ID_MAX), summary: z.string(), ok: z.boolean() })),
    usage: chatUsage.optional(),
  }),
  z.object({
    type: z.literal("ask"),
    id: historyId,
    at: historyAt,
    outboxId: historyId,
    askId: historyId,
    question: z.string(),
    choices: z.array(z.string()),
  }),
  z.object({
    type: z.literal("divider"),
    id: historyId,
    at: historyAt,
    kind: z.enum(["new", "rotated", "compacted"]),
    summary: z.string().optional(),
  }),
]);
export type HistoryItem = z.infer<typeof historyItem>;

export const chatHistoryResult = z.object({
  items: z.array(historyItem).max(CHAT_HISTORY_LIMIT_MAX),
  // null = the start of the transcript.
  before: z.string().max(ID_MAX).nullable(),
});
export type ChatHistoryResult = z.infer<typeof chatHistoryResult>;

export const uploadReadParams = z.object({ principalId: z.string().max(ID_MAX), uploadId });
export type UploadReadParams = z.infer<typeof uploadReadParams>;
export const uploadReadResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    name: z.string().max(ID_MAX),
    contentType: z.string().min(1).max(ID_MAX),
    dataBase64: z
      .string()
      .max(base64Len(UPLOAD_MAX_BYTES))
      .refine((s) => s.length % 4 === 0 && BASE64_RE.test(s), "dataBase64 must be padded base64"),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type UploadReadResult = z.infer<typeof uploadReadResult>;

export const deliverFile = z.object({
  name: z.string().min(1).max(ID_MAX),
  contentType: z.string().min(1).max(ID_MAX),
  dataBase64: z
    .string()
    .max(base64Len(DELIVER_FILE_MAX_BYTES))
    .refine((s) => s.length % 4 === 0 && BASE64_RE.test(s), "dataBase64 must be padded base64"),
});
export type DeliverFile = z.infer<typeof deliverFile>;

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
  // kind "auth": a sign-in link to open. https only: zod's url() alone accepts javascript: and data:.
  auth: z.object({ url: z.string().max(4096).refine(isHttpsUrl, "must be an https: URL"), instructions: z.string() }).optional(),
  // Set on the reply that ends a surface login, so the bot stops treating pastes as its callback.
  authResult: z.enum(["ok", "failed", "cancelled", "timeout"]).optional(),
  // kind "auth" and authResult: the login they belong to, so a resent result can't end a newer login.
  loginId: z.string().max(ID_MAX).optional(),
  // kind "reply": files the turn sent with send_file, attached to the reply.
  files: z
    .array(deliverFile)
    .max(DELIVER_FILES_MAX)
    .refine((fs) => fs.reduce((n, f) => n + base64Bytes(f.dataBase64), 0) <= DELIVER_FILES_TOTAL_MAX_BYTES, "files exceed the per-delivery size cap")
    .optional(),
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

// ── GitHub credentials (workspace → bot). ──
// Lands in an api.github.com path, so no dots-only names and nothing outside GitHub's own name charset.
export const GITHUB_REPO_RE = /^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export const githubTokenParams = z.object({
  principalId: z.string().max(ID_MAX),
  repo: z.string().regex(GITHUB_REPO_RE, "repo must be owner/name"),
});
export type GitHubTokenParams = z.infer<typeof githubTokenParams>;
/** `expiresAt` is epoch ms. `botName`/`botEmail` are the App's commit identity. */
export type GitHubTokenResult = { ok: true; token: string; expiresAt: number; botName: string; botEmail: string } | { ok: false; error: string };

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
