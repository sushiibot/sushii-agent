-- Baseline hand-tuned to reproduce the legacy prod schema EXACTLY (migrations 0–10 squashed):
-- `IF NOT EXISTS` everywhere so it's a no-op on existing DBs; inline UNIQUE (not named unique
-- indexes) and no explicit NOT NULL on PK columns, matching the original DDL byte-for-behavior.
-- FTS5 virtual tables + triggers appended by hand (Drizzle can't model them). The snapshot may
-- describe unique constraints as named indexes; the physical schema here is authoritative.
CREATE TABLE IF NOT EXISTS `agent_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`guild_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	UNIQUE(`guild_id`, `title`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_memory_guild` ON `agent_memory` (`guild_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversations` (
	`thread_id` text PRIMARY KEY,
	`guild_id` text NOT NULL,
	`messages` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`initial_thread_context` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_oauth_clients` (
	`client_id` text PRIMARY KEY,
	`redirect_uris` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_oauth_sessions` (
	`token` text PRIMARY KEY,
	`identity` text NOT NULL,
	`permitted_guild_ids` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`discord_id` text NOT NULL UNIQUE,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`reply_to_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`author_username` text,
	`author_display_name` text,
	`is_automod` integer DEFAULT 0 NOT NULL,
	`is_bot` integer DEFAULT 0 NOT NULL,
	`parent_channel_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_guild_channel` ON `messages` (`guild_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_guild_author` ON `messages` (`guild_id`,`author_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_created_at` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pending_questions` (
	`thread_id` text PRIMARY KEY,
	`question` text NOT NULL,
	`choices` text NOT NULL,
	`triggered_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `server_context` (
	`guild_id` text PRIMARY KEY,
	`content` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wiki_sync_state` (
	`guild_id` text PRIMARY KEY,
	`last_processed_at` integer NOT NULL
);
--> statement-breakpoint
-- FTS5 external content table — content is stored in messages, FTS stores the index only
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	content,
	author_id UNINDEXED,
	channel_id UNINDEXED,
	content='messages',
	content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, content, author_id, channel_id)
	  VALUES (new.id, new.content, new.author_id, new.channel_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, content, author_id, channel_id)
	  VALUES ('delete', old.id, old.content, old.author_id, old.channel_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, content, author_id, channel_id)
	  VALUES ('delete', old.id, old.content, old.author_id, old.channel_id);
	INSERT INTO messages_fts(rowid, content, author_id, channel_id)
	  VALUES (new.id, new.content, new.author_id, new.channel_id);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
	title,
	content,
	guild_id UNINDEXED,
	content='agent_memory',
	content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memory BEGIN
	INSERT INTO agent_memory_fts(rowid, title, content, guild_id)
	  VALUES (new.id, new.title, new.content, new.guild_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memory BEGIN
	INSERT INTO agent_memory_fts(agent_memory_fts, rowid, title, content, guild_id)
	  VALUES ('delete', old.id, old.title, old.content, old.guild_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS agent_memory_au AFTER UPDATE ON agent_memory BEGIN
	INSERT INTO agent_memory_fts(agent_memory_fts, rowid, title, content, guild_id)
	  VALUES ('delete', old.id, old.title, old.content, old.guild_id);
	INSERT INTO agent_memory_fts(rowid, title, content, guild_id)
	  VALUES (new.id, new.title, new.content, new.guild_id);
END;
