import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
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

export const wikiSyncState = sqliteTable("wiki_sync_state", {
  guildId: text("guild_id").primaryKey(),
  lastProcessedAt: integer("last_processed_at").notNull(),
});

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
