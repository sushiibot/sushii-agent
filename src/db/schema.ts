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
];
