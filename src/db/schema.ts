// Each entry is an array of SQL statements for that migration version.
// On startup, runMigrations applies pending migrations in order and updates PRAGMA user_version.
export const MIGRATIONS: string[][] = [
  // Migration 0 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to_id TEXT,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted_at INTEGER
    )`,

    `CREATE INDEX IF NOT EXISTS idx_messages_guild_channel ON messages(guild_id, channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_guild_author ON messages(guild_id, author_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,

    // FTS5 external content table — content is stored in messages, FTS stores the index only
    `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      author_id UNINDEXED,
      channel_id UNINDEXED,
      content='messages',
      content_rowid='id'
    )`,

    // Triggers to keep the FTS index in sync with the messages table
    `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, author_id, channel_id)
        VALUES (new.id, new.content, new.author_id, new.channel_id);
    END`,

    `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, author_id, channel_id)
        VALUES ('delete', old.id, old.content, old.author_id, old.channel_id);
    END`,

    `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, author_id, channel_id)
        VALUES ('delete', old.id, old.content, old.author_id, old.channel_id);
      INSERT INTO messages_fts(rowid, content, author_id, channel_id)
        VALUES (new.id, new.content, new.author_id, new.channel_id);
    END`,

    `CREATE TABLE IF NOT EXISTS conversations (
      thread_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ],

  // Migration 1 — add author username/display name to messages
  [
    `ALTER TABLE messages ADD COLUMN author_username TEXT`,
    `ALTER TABLE messages ADD COLUMN author_display_name TEXT`,
  ],

  // Migration 2 — track AutoMod alert messages (MessageType.AutoModerationAction = 24)
  [
    `ALTER TABLE messages ADD COLUMN is_automod INTEGER NOT NULL DEFAULT 0`,
  ],

  // Migration 3 — track whether the author is a bot
  [
    `ALTER TABLE messages ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`,
  ],

  // Migration 4 — store initial thread context snapshot for stable prompt caching
  [
    `ALTER TABLE conversations ADD COLUMN initial_thread_context TEXT`,
  ],

  // Migration 5 — server context (CLAUDE.md equivalent) + agent memory
  [
    `CREATE TABLE IF NOT EXISTS server_context (
      guild_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(guild_id, title)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_agent_memory_guild ON agent_memory(guild_id)`,
  ],

  // Migration 6 — persist pending questions across restarts
  [
    `CREATE TABLE IF NOT EXISTS pending_questions (
      thread_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      choices TEXT NOT NULL,
      triggered_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],

  // Migration 7 — FTS5 search over agent memory (title + content)
  [
    `CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
      title,
      content,
      guild_id UNINDEXED,
      content='agent_memory',
      content_rowid='id'
    )`,

    `INSERT INTO agent_memory_fts(rowid, title, content, guild_id)
      SELECT id, title, content, guild_id FROM agent_memory`,

    `CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(rowid, title, content, guild_id)
        VALUES (new.id, new.title, new.content, new.guild_id);
    END`,

    `CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, title, content, guild_id)
        VALUES ('delete', old.id, old.title, old.content, old.guild_id);
    END`,

    `CREATE TRIGGER IF NOT EXISTS agent_memory_au AFTER UPDATE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, title, content, guild_id)
        VALUES ('delete', old.id, old.title, old.content, old.guild_id);
      INSERT INTO agent_memory_fts(rowid, title, content, guild_id)
        VALUES (new.id, new.title, new.content, new.guild_id);
    END`,
  ],

  // Migration 8 — persist MCP bridge OAuth clients and sessions across restarts. Every deploy
  // previously wiped these (in-memory only), forcing every MCP client to re-register and every
  // user to re-login. Pending auth/consent/authorization-code state stays in-memory — those are
  // all short-TTL mid-flow artifacts where losing them on a restart just means retrying a login.
  [
    `CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      client_id TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS mcp_oauth_sessions (
      token TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      permitted_guild_ids TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ],

  // Migration 9 — wiki-sync watermark. A per-guild cursor (not a rolling time window) so a
  // sweep that dies mid-run or a bot restart can't double-process or silently skip messages —
  // the cursor only advances after a sweep's commit+push succeeds.
  [
    `CREATE TABLE IF NOT EXISTS wiki_sync_state (
      guild_id TEXT PRIMARY KEY,
      last_processed_at INTEGER NOT NULL
    )`,
  ],
];
