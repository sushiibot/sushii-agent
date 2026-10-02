import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    discordId: text("discord_id").notNull().unique(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    authorId: text("author_id").notNull(),
    content: text("content").notNull(),
    replyToId: text("reply_to_id"),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
    deletedAt: integer("deleted_at"),
    authorUsername: text("author_username"),
    authorDisplayName: text("author_display_name"),
    isAutomod: integer("is_automod").notNull().default(0),
    isBot: integer("is_bot").notNull().default(0),
    parentChannelId: text("parent_channel_id"),
  },
  (table) => [
    index("idx_messages_guild_channel").on(table.guildId, table.channelId),
    index("idx_messages_guild_author").on(table.guildId, table.authorId),
    index("idx_messages_created_at").on(table.createdAt),
  ],
);

export const conversations = sqliteTable("conversations", {
  threadId: text("thread_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  messages: text("messages").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  initialThreadContext: text("initial_thread_context"),
});

export const serverContext = sqliteTable("server_context", {
  guildId: text("guild_id").primaryKey(),
  content: text("content").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const agentMemory = sqliteTable(
  "agent_memory",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.guildId, table.title),
    index("idx_agent_memory_guild").on(table.guildId),
  ],
);

export const pendingQuestions = sqliteTable("pending_questions", {
  threadId: text("thread_id").primaryKey(),
  question: text("question").notNull(),
  choices: text("choices").notNull(),
  triggeredByUserId: text("triggered_by_user_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const mcpOauthClients = sqliteTable("mcp_oauth_clients", {
  clientId: text("client_id").primaryKey(),
  redirectUris: text("redirect_uris").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const mcpOauthSessions = sqliteTable("mcp_oauth_sessions", {
  token: text("token").primaryKey(),
  identity: text("identity").notNull(),
  permittedGuildIds: text("permitted_guild_ids").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Per-source sweep cursor for a wiki. One wiki (`wikiId`) can be fed by many sources, each a
 *  `(surface, spaceId)` pair keeping its own independent watermark. */
export const wikiSyncSourceState = sqliteTable(
  "wiki_sync_source_state",
  {
    wikiId: text("wiki_id").notNull(),
    surface: text("surface").notNull(),
    spaceId: text("space_id").notNull(),
    lastProcessedAt: integer("last_processed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.wikiId, t.surface, t.spaceId] })],
);

/** Poll cursor for the buzz surface — last-processed mention `created_at` (unix seconds). Single row. */
export const buzzState = sqliteTable("buzz_state", {
  id: text("id").primaryKey(),
  lastCursor: integer("last_cursor").notNull(),
});

/** Raw Slack message archive — kept at full Slack fidelity (never flattened into `messages`, which
 *  is discord.js-shaped). `rawJson` holds the whole event so nothing is ever lost; the extracted
 *  columns exist for querying. Keyed on (channel, ts) for idempotent upsert across live + backfill. */
export const slackMessages = sqliteTable(
  "slack_messages",
  {
    channel: text("channel").notNull(),
    ts: text("ts").notNull(),
    threadTs: text("thread_ts"),
    user: text("user"),
    botId: text("bot_id"),
    subtype: text("subtype"),
    text: text("text").notNull().default(""),
    blocks: text("blocks"),
    files: text("files"),
    team: text("team"),
    editedTs: text("edited_ts"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    rawJson: text("raw_json").notNull(),
    ingestedAt: integer("ingested_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channel, table.ts] }),
    index("idx_slack_messages_channel_created").on(table.channel, table.createdAt),
    index("idx_slack_messages_thread").on(table.threadTs),
  ],
);

/** Per-channel backfill progress so a restart resumes without re-crawling. `oldestBackfilled` is the
 *  oldest ts the historical crawl has reached (resume the backward crawl from here); `latestSeen` is
 *  the newest ts observed (forward catch-up starts here). Both are Slack ts strings. */
export const slackSyncState = sqliteTable("slack_sync_state", {
  channel: text("channel").primaryKey(),
  oldestBackfilled: text("oldest_backfilled"),
  latestSeen: text("latest_seen"),
  updatedAt: integer("updated_at").notNull(),
});

// Legacy: `tasks`, `task_messages` and `runner_routing` belong to the removed task-runner system. No
// code reads or writes them; the tables stay so existing databases and migrations keep matching.
const TASK_STATUSES = ["running", "idle", "needs_input", "done", "failed"] as const;

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by").notNull(),
    runnerId: text("runner_id").notNull(),
    project: text("project"),
    cwd: text("cwd"), // the task's working directory — needed to resume in the right place
    nativeSessionId: text("native_session_id"),
    resumeCursor: text("resume_cursor"),
    status: text("status", { enum: TASK_STATUSES }).notNull(),
    statusReason: text("status_reason"),
    summary: text("summary"),
    spawnedFromSurface: text("spawned_from_surface").notNull(),
    threadRefs: text("thread_refs").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"), // set when an idle/done/failed task ages out of the live roster
  },
  (table) => [index("idx_tasks_created_by").on(table.createdBy)],
);

export const taskMessages = sqliteTable(
  "task_messages",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["agent_to_owner", "owner_to_agent"] }).notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed"] }).notNull(),
    discordMessageId: text("discord_message_id").unique(),
    failure: text("failure"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
  },
  (table) => [index("idx_task_messages_task_status").on(table.taskId, table.status, table.createdAt)],
);

export const runnerRouting = sqliteTable(
  "runner_routing",
  {
    principal: text("principal").notNull(),
    projectKey: text("project_key").notNull(),
    runnerId: text("runner_id").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.principal, table.projectKey] })],
);

/** New-member screening verdicts (one row per text/pfp/image check, plus AutoMod blocks). Also the PFP and image-link
 *  dedupe cache, and the outcome log (ignored/actioned) used to tune thresholds. */
export const screeningVerdicts = sqliteTable(
  "screening_verdicts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    userId: text("user_id").notNull(),
    messageId: text("message_id").notNull(),
    kind: text("kind", { enum: ["text", "pfp", "image", "automod"] }).notNull(),
    // text: {rule: probability}; pfp/image: {unsafe: 0|1}
    scores: text("scores"),
    categories: text("categories"),
    topRule: text("top_rule"),
    flagged: integer("flagged").notNull().default(0),
    avatarHash: text("avatar_hash"),
    imageKey: text("image_key"),
    sourceUrl: text("source_url"),
    joinedAt: integer("joined_at"),
    ordinal: integer("ordinal"),
    model: text("model"),
    cost: real("cost"),
    // snapshot of what was judged — the message cache drops content after 30 days
    judged: text("judged"),
    error: text("error"),
    postChannelId: text("post_channel_id"),
    postMessageId: text("post_message_id"),
    outcome: text("outcome", { enum: ["ignored", "actioned"] }),
    outcomeBy: text("outcome_by"),
    outcomeAction: text("outcome_action"),
    outcomeAt: integer("outcome_at"),
    messageDeleted: integer("message_deleted").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_screening_guild_user").on(table.guildId, table.userId, table.createdAt),
    index("idx_screening_pfp").on(table.userId, table.avatarHash),
    index("idx_screening_image").on(table.imageKey),
    index("idx_screening_message").on(table.messageId),
    index("idx_screening_post").on(table.postMessageId),
  ],
);

/** Workspace outbox ids already rendered to Discord, so a resent chat/deliver is only re-acked. */
export const workspaceOutboxSeen = sqliteTable("workspace_outbox_seen", {
  outboxId: text("outbox_id").primaryKey(),
  principalId: text("principal_id").notNull(),
  seenAt: integer("seen_at").notNull(),
});

/** Owner-DM exchanges answered by the in-process fallback while the workspace was offline; replayed
 *  to the workspace as context on its next register, then deleted. */
export const workspaceInbox = sqliteTable("workspace_inbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  principalId: text("principal_id").notNull(),
  userText: text("user_text").notNull(),
  replyText: text("reply_text").notNull(),
  createdAt: integer("created_at").notNull(),
  // Where the answered message came from; null on rows recorded before origins were stored.
  originSurface: text("origin_surface"),
  originConversationId: text("origin_conversation_id"),
});

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Web Push subscriptions for the personal web app; endpoint is the push service URL. */
export const webPushSubscriptions = sqliteTable("web_push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: integer("created_at").notNull(),
  lastOkAt: integer("last_ok_at"),
});

/** Web chat files: owner photos (`in`) and agent send_file deliveries (`out`). Bytes live on disk at `path`,
 *  relative to the uploads root and built only from bot values. */
export const webUploads = sqliteTable(
  "web_uploads",
  {
    id: text("id").primaryKey(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    contentType: text("content_type").notNull(),
    inline: integer("inline").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    // `in:<X-Client-Id>` or `out:<outboxId>#<index>`: the idempotency key of a put.
    clientKey: text("client_key").unique(),
    outboxId: text("outbox_id"),
    messageClientId: text("message_client_id"),
    createdAt: integer("created_at").notNull(),
    referencedAt: integer("referenced_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [index("idx_web_uploads_direction_created").on(table.direction, table.createdAt), index("idx_web_uploads_outbox").on(table.outboxId)],
);

/** Durable web chat events; `seq` is the SSE event id. AUTOINCREMENT so a seq is never reissued after a prune. */
export const webEvents = sqliteTable(
  "web_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull().default("main"),
    type: text("type").notNull(),
    // Idempotency key (clientId, outboxId, nonce, …); null for events that are never retried.
    key: text("key"),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull(),
    // History order: a turn's reply sorts at the seq its turn started after; null sorts at its own seq.
    sortSeq: integer("sort_seq"),
  },
  (table) => [
    uniqueIndex("uq_web_events_type_key").on(table.conversationId, table.type, table.key),
    index("idx_web_events_created").on(table.createdAt),
    index("idx_web_events_order").on(sql`coalesce(${table.sortSeq}, ${table.seq})`, table.seq),
    index("idx_web_events_conversation_order").on(table.conversationId, sql`coalesce(${table.sortSeq}, ${table.seq})`, table.seq),
  ],
);

/** The chat head when the web surface first saw each turn, so its reply can sort there after a restart. */
export const webTurnAnchors = sqliteTable("web_turn_anchors", {
  turnId: text("turn_id").primaryKey(),
  anchorSeq: integer("anchor_seq").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Owner web messages, persisted before the 202; `routedAt` is set once the workspace gave a receipt.
 *  `state`: pending (not routed yet), routed, rejected (the workspace refused it) or discarded (the owner deleted it). */
export const webInbound = sqliteTable(
  "web_inbound",
  {
    clientId: text("client_id").primaryKey(),
    conversationId: text("conversation_id").notNull().default("main"),
    text: text("text").notNull(),
    uploadIds: text("upload_ids").notNull(),
    seq: integer("seq").notNull(),
    createdAt: integer("created_at").notNull(),
    routedAt: integer("routed_at"),
    state: text("state").notNull().default("pending"),
  },
  (table) => [index("idx_web_inbound_created").on(table.createdAt)],
);

/** One row per scheduled job that has alerted: its open failure streak, or the last one, cleared. */
export const webAlerts = sqliteTable(
  "web_alerts",
  {
    job: text("job").primaryKey(),
    // "open" | "cleared"
    state: text("state").notNull(),
    // The streak's latest JobAlert as the workspace sent it (failed or stuck).
    alert: text("alert").notNull(),
    // The streak's first failing run's startedAt.
    firstAt: text("first_at").notNull(),
    // The latest `alert` event's seq and outbox key.
    seq: integer("seq").notNull(),
    key: text("key").notNull(),
    dismissedAt: integer("dismissed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_web_alerts_state").on(table.state, table.updatedAt)],
);

/** Failed background runs the owner hid from Home. */
export const webDismissedRuns = sqliteTable("web_dismissed_runs", {
  runId: text("run_id").primaryKey(),
  at: integer("at").notNull(),
});

/** Runs the owner opened, which leave "Ready for review" on every device. */
export const webOpenedRuns = sqliteTable("web_opened_runs", {
  runId: text("run_id").primaryKey(),
  at: integer("at").notNull(),
});

/** Scheduled-job messages shown on Home instead of in the chat, kept until the owner marks them done. */
export const webInbox = sqliteTable(
  "web_inbox",
  {
    // The delivery's outbox key, so a resent delivery stores nothing new.
    key: text("key").primaryKey(),
    job: text("job").notNull(),
    runId: text("run_id"),
    text: text("text").notNull(),
    at: integer("at").notNull(),
    readAt: integer("read_at"),
    doneAt: integer("done_at"),
  },
  (table) => [index("idx_web_inbox_done").on(table.doneAt, table.at)],
);

export const webThreads = sqliteTable("web_threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
  archivedBy: text("archived_by"),
  report: text("report"),
  reportDelivered: integer("report_delivered").notNull().default(0),
});
