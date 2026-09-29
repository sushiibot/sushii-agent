import { index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { TASK_STATUSES } from "../orchestration/contracts.ts";

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

/** Orchestration task registry (Phase 0). Pointers only — the runner holds the real transcript. */
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

/** Remembered runner choice per (principal, project) — so dispatch only asks which runner once,
 *  then routes automatically. A lightweight routing memory; a future general memory system can
 *  subsume it. projectKey = "owner/repo" for clone-on-demand, else the project name / cwd. */
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
