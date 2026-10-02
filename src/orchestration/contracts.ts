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
  topicsManage: "topics/manage",
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
  // Bot → workspace request: one page of the Main transcript's owner messages and final replies, for the
  // bot's one-time import of the conversation from before the web app.
  chatExport: "chat/export",
  // Workspace → bot request: the bytes of an owner photo a chat/message referenced.
  uploadRead: "upload/read",
  // Bot → workspace requests: read-only views of the workspace's run index, transcripts and ~/history.
  runsList: "runs/list",
  runsGet: "runs/get",
  runsStop: "runs/stop",
  historyDays: "history/days",
  historyDay: "history/day",
  historySearch: "history/search",
  // Workspace → bot notification: a run started or ended. Ephemeral; an older bot drops it.
  runsChanged: "runs/changed",
  // Bot → workspace requests: the owner's model choice, as `!model` reads and sets it.
  connectors: "connectors/manage",
  modelsGet: "models/get",
  modelsSet: "models/set",
  // Bot → workspace request: OpenRouter's tool-capable models matching a query, for the app's picker.
  modelsSearch: "models/search",
} as const;

// ── Chat protocol (workspace ↔ bot). ──
// Where a chat message came from; replies/events echo it so the bot routes them back to that surface.
// Optional on deliver/event: a proactive message has none, and neither do entries outboxed before origins.
export const chatOrigin = z.object({ surface: z.string(), conversationId: z.string() });
export type ChatOrigin = z.infer<typeof chatOrigin>;

export const TOPIC_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const topicsManageParams = z.object({
  principalId: z.string(), id: z.string().regex(TOPIC_ID_RE).refine(id => id !== "main"),
  action: z.enum(["create", "close", "reopen", "rename"]),
  title: z.string().trim().min(1).max(120).optional(),
  brief: z.string().max(16000).optional(),
}).strict();
export const topicsManageResult = z.object({ ok: z.literal(true) }).strict();


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
/** `queued`: the workspace took the message but holds it until its current turn ends; the bot keeps
 *  its row pending and settles it when the turn ends (or a re-drive finds the workspace saw it). */
export type ChatMessageMode = "prompt" | "steer" | "duplicate" | "context" | "queued";
export interface ChatMessageResult {
  accepted: true;
  mode: ChatMessageMode;
}

// With turnId, only that turn is aborted; a stale Stop from a finished turn is a no-op.
export const chatAbortParams = z.object({ principalId: z.string(), turnId: z.string().optional(), origin: chatOrigin.optional() });
export type ChatAbortParams = z.infer<typeof chatAbortParams>;
export interface ChatAbortResult {
  aborted: boolean;
}

export const chatNewParams = z.object({ principalId: z.string(), origin: chatOrigin.optional() });
export type ChatNewParams = z.infer<typeof chatNewParams>;
export interface ChatNewResult {
  sessionFile: string;
}

export const CHAT_COMMANDS = ["compact", "model", "tasks"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];
export const chatCommandParams = z.object({ principalId: z.string(), command: z.enum(CHAT_COMMANDS), args: z.string().max(200).optional(), origin: chatOrigin.optional() });
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

export const MODELS_MAX = 20;
/** models/set's JSON-RPC error code for an alias the workspace's list doesn't have. */
export const UNKNOWN_MODEL_CODE = -32011;
export const MODELS_SEARCH_MAX = 25;
export const modelsGetParams = z.object({ principalId: z.string(), conversationId: z.string().regex(TOPIC_ID_RE).optional() });
/** Recorded model cost for distinct runs; absent prices stay explicit. */
export const historyCost = z.object({
  usd: z.number().finite().nonnegative(),
  recordedRuns: z.number().int().nonnegative(),
  unpricedRuns: z.number().int().nonnegative(),
});
export type HistoryCost = z.infer<typeof historyCost>;
export const modelCosts = z.object({
  session: historyCost.optional(),
  today: historyCost,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().max(100),
  /** Older runs could not be read within the bounded index scan. */
  truncated: z.boolean().optional(),
});
export type ModelCosts = z.infer<typeof modelCosts>;
/** `alias` is a list alias or an OpenRouter id; `role: "fallback"` sets what a ChatGPT choice falls back to. */
export const modelsSetParams = z.object({ principalId: z.string(), alias: z.string().min(1).max(ID_MAX), role: z.enum(["main", "fallback"]).optional() });
export const modelsSearchParams = z.object({ principalId: z.string(), query: z.string().max(100) });
/** Catalog facts, when OpenRouter's catalog could be read; USD per million tokens. */
const modelFacts = {
  contextWindow: z.number().int().positive().optional(),
  priceIn: z.number().nonnegative().nullable().optional(),
  priceOut: z.number().nonnegative().nullable().optional(),
  image: z.boolean().optional(),
};
export const modelsResult = z.object({
  /** The chosen alias, or an OpenRouter id picked outside the list; null while on a default no entry matches. */
  current: z.string().max(ID_MAX).nullable(),
  models: z
    .array(z.object({ alias: z.string().min(1).max(ID_MAX), backend: z.enum(["chatgpt", "openrouter"]), id: z.string().max(ID_MAX), ...modelFacts }))
    .max(MODELS_MAX + 1),
  /** The OpenRouter model a ChatGPT choice falls back to. */
  fallback: z.string().max(ID_MAX).optional(),
  /** While set, ChatGPT is cooling down after a limit or sign-in failure and the fallback answers. */
  fallbackUntil: z.string().max(40).nullable().optional(),
  cost: modelCosts.optional(),
});
export type ModelsResult = z.infer<typeof modelsResult>;
export const modelsSearchResult = z.object({
  models: z.array(z.object({ id: z.string().min(1).max(ID_MAX), name: z.string().max(ID_MAX), ...modelFacts })).max(MODELS_SEARCH_MAX),
});
export type ModelsSearchResult = z.infer<typeof modelsSearchResult>;

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
// Main and topic conversations. The surface adapter also checks that a topic exists.
export const WEB_CONVERSATION_ID = "main";
export const webConversationId = z.string().regex(TOPIC_ID_RE);
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

export const CHAT_EXPORT_TIMEOUT_MS = 30_000;
export const CHAT_EXPORT_LIMIT_MAX = 100;

export const chatExportParams = z.object({
  principalId: z.string(),
  // The id of the oldest item of the previous page; absent = newest.
  before: z.string().max(ID_MAX).optional(),
  limit: z.number().int().min(1).max(CHAT_EXPORT_LIMIT_MAX).default(CHAT_EXPORT_LIMIT_MAX),
});
export type ChatExportParams = z.infer<typeof chatExportParams>;

const exportId = z.string().min(1).max(ID_MAX);
export const chatExportItem = z.object({
  /** `<sessionFileBase>:<entryId>`: stable across exports, so it keys the import. */
  id: exportId,
  role: z.enum(["user", "assistant"]),
  at: z.string().max(ID_MAX),
  text: z.string(),
  /** A web message's clientId, from its `[web:<id> …]` header. */
  clientId: exportId.optional(),
  /** The outbox id the host delivered this reply under. */
  outboxId: exportId.optional(),
});
export type ChatExportItem = z.infer<typeof chatExportItem>;

export const chatExportResult = z.object({
  /** Oldest first. */
  items: z.array(chatExportItem).max(CHAT_EXPORT_LIMIT_MAX),
  // null = the start of the transcript.
  before: z.string().max(ID_MAX).nullable(),
});
export type ChatExportResult = z.infer<typeof chatExportResult>;

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
/** upload/read's error when the bot already has its budget of reads in flight; the caller retries. */
export const UPLOAD_READ_BUSY = "busy";

// The agent's "say nothing" reply; the bot reads it in run summaries too.
export const NO_REPLY = "NO_REPLY";
const NO_REPLY_EDGE = /^NO_REPLY(?:$|[\s.,;:!?—–-])|(?:^|[\s.,;:!?—–-])NO_REPLY$/;

/** Whether a reply means "say nothing": NO_REPLY alone or leading/trailing, even wrapped in markdown, quotes or punctuation. */
export function isNoReply(text: string): boolean {
  const bare = text
    .replace(/[*`"'“”‘’~]/g, "")
    .replace(/^[\s_]+/, "")
    .replace(/[\s_.!?,;:…]+$/, "");
  return NO_REPLY_EDGE.test(bare);
}

// ── Runs and history (bot → workspace, read-only). ──
// Errors follow chat/export: MethodNotFound = an older workspace. The bot re-parses every result with these
// schemas and rejects the whole response on failure, since run and history content is agent-writable.
export const RUNS_TIMEOUT_MS = 10_000;
/** rg's own wall clock in the workspace is 5 s. */
export const HISTORY_SEARCH_TIMEOUT_MS = 8_000;

/** Same alphabet as src/workspace/ulid.ts. Used as a lookup key only, never in a path on the bot. */
export const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const runId = z.string().regex(RUN_ID_RE, "invalid run id");
export const RUN_KINDS = ["chat", "flush", "job", "subagent", "agent", "rotate"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_STATUSES = ["running", "done", "failed", "aborted", "timeout"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const JOB_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const JOB_NAME_MAX = 64;
export const RUN_TITLE_MAX = 200;
export const RUN_RESULT_SUMMARY_MAX = 400;
export const RUNS_PAGE_MAX = 50;
export const RUNS_PAGE_DEFAULT = 30;
export const RUN_STEPS_PAGE_MAX = 200;
export const RUN_STEPS_PAGE_DEFAULT = 100;
export const RUN_CHILDREN_MAX = 50;
/** ISO timestamps as the host writes them; a cap, not a format check, since old records may vary. */
const timestamp = z.string().max(40);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date: "2026-02-30" passes the regex but names no file. */
export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const historyDate = z.string().refine(isCalendarDate, "must be a calendar date YYYY-MM-DD");

/** UTC ISO with `Z` (what toISOString() writes); zod's datetime() rejects offsets by default. */
const isoInstant = z.string().datetime();

export const runsListParams = z.object({
  principalId: z.string().max(ID_MAX),
  /** Absent = newest. Runs are ordered by runId descending (= start time). */
  before: runId.optional(),
  limit: z.number().int().min(1).max(RUNS_PAGE_MAX).default(RUNS_PAGE_DEFAULT),
  kinds: z.array(z.enum(RUN_KINDS)).max(RUN_KINDS.length).optional(),
  statuses: z.array(z.enum(RUN_STATUSES)).max(RUN_STATUSES.length).optional(),
  conversationId: z.string().regex(TOPIC_ID_RE).optional(),
  /** startedAt ≥ since. */
  since: isoInstant.optional(),
  /** startedAt < until. */
  until: isoInstant.optional(),
});
export type RunsListParams = z.infer<typeof runsListParams>;

export const runUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  model: z.string().max(ID_MAX).optional(),
});
export const runsStopParams = z.object({ principalId: z.string(), runId });
export const runsStopResult = z.object({ stopped: z.boolean() });

export const runSummary = z.object({
  runId,
  parentRunId: runId.optional(),
  turnId: z.string().max(ID_MAX).optional(),
  conversationId: z.string().regex(TOPIC_ID_RE).optional(),
  repo: z.string().max(ID_MAX).optional(),
  kind: z.enum(RUN_KINDS),
  agentName: z.string().max(ID_MAX),
  jobName: z.string().max(JOB_NAME_MAX).optional(),
  /** Redacted, one line: the first user text (header stripped) or the task. */
  title: z.string().max(RUN_TITLE_MAX),
  status: z.enum(RUN_STATUSES),
  startedAt: timestamp,
  endedAt: timestamp.optional(),
  usage: runUsage.optional(),
  /** Redacted, one line. */
  resultSummary: z.string().max(RUN_RESULT_SUMMARY_MAX).optional(),
});
export type RunSummary = z.infer<typeof runSummary>;

export const runsListResult = z.object({
  runs: z.array(runSummary).max(RUNS_PAGE_MAX),
  /** null = no older runs. */
  before: runId.nullable(),
  /** The scan bound was hit: older runs exist but this call can't reach them. */
  truncated: z.boolean(),
});
export type RunsListResult = z.infer<typeof runsListResult>;

export const runsGetParams = z.object({
  principalId: z.string().max(ID_MAX),
  runId,
  /** Absent = the run's first step. */
  after: z.string().max(ID_MAX).optional(),
  limit: z.number().int().min(1).max(RUN_STEPS_PAGE_MAX).default(RUN_STEPS_PAGE_DEFAULT),
});
export type RunsGetParams = z.infer<typeof runsGetParams>;

export const RUN_STEP_LIMITS = { user: 4_000, assistant: 8_000, toolArgs: 300, toolResult: 600, note: 600 } as const;
export const RUN_NOTE_KINDS = ["compaction", "verify", "error", "aborted", "custom"] as const;
const stepId = z.string().min(1).max(ID_MAX);
export const runStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: stepId, at: timestamp, text: z.string().max(RUN_STEP_LIMITS.user) }),
  z.object({ type: z.literal("assistant"), id: stepId, at: timestamp, text: z.string().max(RUN_STEP_LIMITS.assistant) }),
  z.object({
    type: z.literal("tool"),
    id: stepId,
    at: timestamp,
    name: z.string().max(ID_MAX),
    args: z.string().max(RUN_STEP_LIMITS.toolArgs),
    /** null: no result inside the run's window. */
    ok: z.boolean().nullable(),
    result: z.string().max(RUN_STEP_LIMITS.toolResult),
    durationMs: z.number().int().nonnegative().optional(),
    /** A child run's steps are not inlined; see `children`. */
    agentId: z.string().max(ID_MAX).optional(),
  }),
  z.object({ type: z.literal("note"), id: stepId, at: timestamp, kind: z.enum(RUN_NOTE_KINDS), text: z.string().max(RUN_STEP_LIMITS.note) }),
]);
export type RunStep = z.infer<typeof runStep>;

export const runEvidence = z.object({
  checks: z.array(z.object({ command: z.string().max(200), ok: z.boolean().nullable(), at: timestamp })).max(20),
  changedRepos: z.array(z.string().max(100)).max(20),
  /** null: nothing under projects/ changed. */
  checkAfterLastChange: z.boolean().nullable(),
  /** A sushii-verify-gate entry is in the window. */
  verifyNudged: z.boolean(),
  filesSent: z.array(z.object({ name: z.string().max(ID_MAX), at: timestamp })).max(DELIVER_FILES_MAX * 5),
  memoryWrites: z.array(z.object({ path: z.string().max(300), tool: z.enum(["write", "edit", "bash"]), at: timestamp })).max(50),
});
export type RunEvidence = z.infer<typeof runEvidence>;

export const RUN_SESSION_STATES = ["ok", "missing", "outside", "not-session"] as const;
export const runsGetResult = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    run: runSummary,
    parent: runSummary.optional(),
    children: z.array(runSummary).max(RUN_CHILDREN_MAX),
    /** Why steps may be empty. */
    session: z.enum(RUN_SESSION_STATES),
    steps: z.array(runStep).max(RUN_STEPS_PAGE_MAX),
    /** null = the last step is in this page. */
    after: z.string().max(ID_MAX).nullable(),
    /** First page only. */
    evidence: runEvidence.optional(),
    /** "YYYY-MM/DD-<runId>.md", for the History link. */
    historyFile: z.string().max(100).optional(),
  }),
]);
export type RunsGetResult = z.infer<typeof runsGetResult>;

export const HISTORY_DAYS_PAGE_MAX = 60;
export const HISTORY_DAYS_PAGE_DEFAULT = 30;
export const HISTORY_DAY_SESSIONS_MAX = 50;
export const HISTORY_DAY_RUNS_MAX = 200;
export const HISTORY_RECAP_MAX = 32_000;

export const historyDaysParams = z.object({
  principalId: z.string().max(ID_MAX),
  before: historyDate.optional(),
  limit: z.number().int().min(1).max(HISTORY_DAYS_PAGE_MAX).default(HISTORY_DAYS_PAGE_DEFAULT),
});
export type HistoryDaysParams = z.infer<typeof historyDaysParams>;
export const historyDaysResult = z.object({
  days: z
    .array(z.object({ date: historyDate, runs: z.number().int().nonnegative(), sessions: z.number().int().nonnegative(), cost: historyCost.optional() }))
    .max(HISTORY_DAYS_PAGE_MAX),
  before: historyDate.nullable(),
});
export type HistoryDaysResult = z.infer<typeof historyDaysResult>;

/** The workspace builds the file name from a validated date; the string never joins a path unchecked. */
export const historyDayParams = z.object({ principalId: z.string().max(ID_MAX), date: historyDate });
export type HistoryDayParams = z.infer<typeof historyDayParams>;
export const historyDayResult = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    date: historyDate,
    sessions: z.array(z.object({ heading: z.string().max(300), markdown: z.string().max(HISTORY_RECAP_MAX) })).max(HISTORY_DAY_SESSIONS_MAX),
    /** Runs whose run file is under YYYY-MM/DD-*, i.e. that started that local day. */
    runs: z.array(runSummary).max(HISTORY_DAY_RUNS_MAX),
    cost: historyCost.optional(),
    /** The day's file was larger than the read cap. */
    truncated: z.boolean(),
  }),
]);
export type HistoryDayResult = z.infer<typeof historyDayResult>;

export const HISTORY_QUERY_MIN = 2;
export const HISTORY_QUERY_MAX = 200;
export const HISTORY_SEARCH_PAGE_MAX = 50;
export const HISTORY_SEARCH_PAGE_DEFAULT = 20;
export const SEARCH_SNIPPET_MAX = 240;
export const SEARCH_RANGES_MAX = 5;
export const historySearchParams = z.object({
  principalId: z.string().max(ID_MAX),
  /** A literal (rg -F), smart-case. */
  query: z.string().trim().min(HISTORY_QUERY_MIN).max(HISTORY_QUERY_MAX),
  scope: z.enum(["all", "daily", "runs"]).default("all"),
  before: z.string().max(ID_MAX).optional(),
  limit: z.number().int().min(1).max(HISTORY_SEARCH_PAGE_MAX).default(HISTORY_SEARCH_PAGE_DEFAULT),
});
export type HistorySearchParams = z.infer<typeof historySearchParams>;
/** [start, end) in code points of the snippet. */
export const searchRange = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([s, e]) => s < e, "a range must be non-empty");
export const searchHit = z.object({
  /** "<relPath>:<line>", also the cursor. */
  id: z.string().max(ID_MAX),
  kind: z.enum(["daily", "run"]),
  date: historyDate,
  runId: runId.optional(),
  line: z.number().int().positive(),
  /** The nearest preceding "## " or "### " line. */
  heading: z.string().max(200).optional(),
  /** One line, redacted. */
  snippet: z.string().max(SEARCH_SNIPPET_MAX),
  ranges: z.array(searchRange).max(SEARCH_RANGES_MAX),
});
export type SearchHit = z.infer<typeof searchHit>;
export const historySearchResult = z.object({
  hits: z.array(searchHit).max(HISTORY_SEARCH_PAGE_MAX),
  before: z.string().max(ID_MAX).nullable(),
  /** A time, byte or file-count cap was hit. */
  truncated: z.boolean(),
});
export type HistorySearchResult = z.infer<typeof historySearchResult>;

/** Workspace → bot notification (no response). */
export const runsChangedParams = z.object({
  principalId: z.string().max(ID_MAX),
  runId,
  conversationId: z.string().regex(TOPIC_ID_RE).optional(),
  repo: z.string().max(ID_MAX).optional(),
  kind: z.enum(RUN_KINDS),
  status: z.enum(RUN_STATUSES),
  parentRunId: runId.optional(),
  jobName: z.string().max(JOB_NAME_MAX).optional(),
});
export type RunsChangedParams = z.infer<typeof runsChangedParams>;

// ── Structured job alerts (chat/deliver kind "alert"). ──
export const ALERT_ERROR_MAX = 200;
export const ALERT_SCHEDULE_MAX = 120;
export const JOB_ALERT_KINDS = ["failed", "stuck", "recovered"] as const;
export const JOB_TRIGGERS = ["daily", "interval", "catchup", "manual"] as const;
export const jobAlert = z.object({
  source: z.literal("job"),
  job: z.string().regex(JOB_NAME_RE, "invalid job name"),
  kind: z.enum(JOB_ALERT_KINDS),
  trigger: z.enum(JOB_TRIGGERS),
  startedAt: isoInstant,
  /** Already redacted by alertErrorText; the bot caps it again before storage and push. */
  error: z.string().max(ALERT_ERROR_MAX).optional(),
  schedule: z.string().max(ALERT_SCHEDULE_MAX),
  disabled: z.boolean().optional(),
  runId: runId.optional(),
});
export type JobAlertWire = z.infer<typeof jobAlert>;

export const deliverJob = z.object({ name: z.string().min(1).max(JOB_NAME_MAX), runId: runId.optional() });
export type DeliverJob = z.infer<typeof deliverJob>;

export const CHAT_DELIVER_KINDS = ["reply", "proactive", "ask", "auth", "alert"] as const;
export type ChatDeliverKind = (typeof CHAT_DELIVER_KINDS)[number];

/** Delivery kinds a bot may advertise in its register result. The workspace sends `alert` only when listed;
 *  otherwise it rewrites queued alerts to `proactive` (dropping `alert`, which the refine below rejects). */
export const WORKSPACE_FEATURES = ["alert"] as const;
export type WorkspaceFeature = (typeof WORKSPACE_FEATURES)[number];

export const deliverFile = z.object({
  name: z.string().min(1).max(ID_MAX),
  contentType: z.string().min(1).max(ID_MAX),
  dataBase64: z
    .string()
    .max(base64Len(DELIVER_FILE_MAX_BYTES))
    .refine((s) => s.length % 4 === 0 && BASE64_RE.test(s), "dataBase64 must be padded base64"),
});
export type DeliverFile = z.infer<typeof deliverFile>;

export const chatDeliverParams = z
  .object({
    origin: chatOrigin.optional(),
    outboxId: z.string(),
    principalId: z.string(),
    kind: z.enum(CHAT_DELIVER_KINDS),
    text: z.string(),
    replyTo: z.string().optional(),
    turnId: z.string().optional(),
    usage: chatUsage.optional(),
    ask: z.object({ askId: z.string(), question: z.string(), choices: z.array(z.string()).optional(), toolConfirmation: z.object({ tool: z.string().max(256), input: z.string().max(16000), reason: z.string().max(1000).optional(), toolCallId: z.string().max(256).optional() }).optional() }).optional(),
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
    // kind "alert": the structured job alert; `text` is jobAlertText(alert), so any surface can show it as plain text.
    alert: jobAlert.optional(),
    // kind "proactive": the scheduled job that sent it, so a surface with an inbox can file it there.
    job: deliverJob.optional(),
  })
  .refine((p) => (p.kind === "alert") === (p.alert !== undefined), { message: 'kind "alert" needs alert, and only it may carry one', path: ["alert"] })
  .refine((p) => p.job === undefined || p.kind === "proactive", { message: 'only kind "proactive" may carry job', path: ["job"] });
export type ChatDeliverParams = z.infer<typeof chatDeliverParams>;

export const chatEventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("tool_start"), name: z.string(), summary: z.string(), toolCallId: z.string().min(1).max(256).optional() }),
  z.object({ type: z.literal("tool_end"), name: z.string(), ok: z.boolean(), toolCallId: z.string().min(1).max(256).optional() }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("model_activity"), activity: z.enum(["waiting", "thinking"]) }),
  z.object({ type: z.literal("turn_end"), aborted: z.boolean() }),
]);
export type ChatEventPayload = z.infer<typeof chatEventPayload>;

export const chatEventParams = z.object({
  origin: chatOrigin.optional(),
  principalId: z.string(),
  turnId: z.string().min(1).max(ID_MAX),
  agentId: z.string().min(1).max(ID_MAX), // "main" | <runId> of a subagent
  parentRunId: z.string().max(ID_MAX).optional(),
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
export const workspaceRegisterResult = z.object({
  ok: z.literal(true),
  tools: z.array(toolManifestEntry),
  /** Unknown entries are kept as strings so a newer bot's list still parses; an older bot omits the field. */
  features: z.array(z.string().max(32)).max(16).optional(),
});
export type WorkspaceRegisterResult = z.infer<typeof workspaceRegisterResult>;

export const toolCallParams = z.object({
  principalId: z.string().max(ID_MAX),
  callId: z.string().min(1).max(ID_MAX),
  name: z.string().max(ID_MAX),
  args: z.unknown(),
  agentId: z.string().min(1).max(ID_MAX), // "main" | <runId>
  agentName: z.string().max(ID_MAX),
  parentRunId: z.string().max(ID_MAX).optional(),
  origin: chatOrigin.optional(),
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

// Owner-managed remote MCP connections. Credentials never appear in responses.
export const CONNECTOR_ERROR_CODE = -32042;
export const connectorTool = z.object({ name: z.string(), description: z.string(), change: z.enum(["added", "removed", "changed"]).optional() });
export const connectorServer = z.object({
  id: z.string(), name: z.string(), url: z.string(), status: z.enum(["connected", "error", "signed-out"]),
  problem: z.string().optional(), tools: z.number(), changed: z.boolean(), enabled: z.boolean(),
  snapshotAt: z.string(), toolList: z.array(connectorTool),
  history: z.array(z.object({ at: z.string(), event: z.string() })),
  usedBy: z.array(z.object({ runId: z.string(), title: z.string(), tool: z.string(), at: z.string() })),
});
export type ConnectorServer = z.infer<typeof connectorServer>;
export const connectorRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("get"), id: z.string().uuid() }),
  z.object({ action: z.literal("begin"), url: z.string().url().max(2048), token: z.string().min(1).max(8192).optional() }),
  z.object({ action: z.literal("finish"), url: z.string().url().max(2048), redirect: z.string().max(4096) }),
  z.object({ action: z.enum(["accept", "reconnect", "disconnect", "remove"]), id: z.string().uuid() }),
]);
export type ConnectorRequest = z.infer<typeof connectorRequest>;
export const connectorsParams = z.object({ principalId: z.string(), request: connectorRequest });
export const connectorsResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), servers: z.array(connectorServer) }),
  z.object({ kind: z.literal("server"), server: connectorServer.nullable() }),
  z.object({ kind: z.literal("auth"), name: z.string(), authUrl: z.string().url() }),
  z.object({ kind: z.literal("removed") }),
]);
export type ConnectorsResult = z.infer<typeof connectorsResult>;
