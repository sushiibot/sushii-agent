import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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

/** Orchestration task registry (Phase 0). Pointers only — the runner holds the real transcript. */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by").notNull(),
    runnerId: text("runner_id").notNull(),
    project: text("project"),
    nativeSessionId: text("native_session_id"),
    resumeCursor: text("resume_cursor"),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    summary: text("summary"),
    spawnedFromSurface: text("spawned_from_surface").notNull(),
    threadRefs: text("thread_refs").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_tasks_created_by").on(table.createdBy)],
);
