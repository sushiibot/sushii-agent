import type { Database } from "bun:sqlite";

export interface WikiSyncMessage {
  discordId: string;
  channelId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  content: string;
  createdAt: number;
}

/** Cursor for this guild's next sweep. 0 (never synced) means "everything currently retained". */
export function getWikiSyncWatermark(db: Database, guildId: string): number {
  const row = db.query(`SELECT last_processed_at FROM wiki_sync_state WHERE guild_id = ?`).get(guildId) as
    | { last_processed_at: number }
    | null;
  return row?.last_processed_at ?? 0;
}

export function setWikiSyncWatermark(db: Database, guildId: string, timestamp: number): void {
  db.run(
    `INSERT INTO wiki_sync_state (guild_id, last_processed_at) VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET last_processed_at = excluded.last_processed_at`,
    [guildId, timestamp],
  );
}

/**
 * Messages newer than `since`, oldest first, capped at `limit`. Excludes bot messages and
 * soft-deleted messages — a user who deleted a message should not have it land in a public wiki.
 */
export function getUnprocessedMessages(db: Database, guildId: string, since: number, limit: number): WikiSyncMessage[] {
  const rows = db
    .query(
      `SELECT discord_id, channel_id, author_id, author_username, author_display_name, content, created_at
       FROM messages
       WHERE guild_id = ? AND created_at > ? AND deleted_at IS NULL AND is_bot = 0
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(guildId, since, limit) as Array<{
    discord_id: string;
    channel_id: string;
    author_id: string;
    author_username: string;
    author_display_name: string | null;
    content: string;
    created_at: number;
  }>;

  return rows.map((r) => ({
    discordId: r.discord_id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorUsername: r.author_username,
    authorDisplayName: r.author_display_name,
    content: r.content,
    createdAt: r.created_at,
  }));
}
