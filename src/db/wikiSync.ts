import type { Database } from "bun:sqlite";

export interface WikiSyncMessage {
  discordId: string;
  channelId: string;
  /** Set when channelId is a thread — the channel the thread lives under. */
  parentChannelId: string | null;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  content: string;
  createdAt: number;
  /** Present when this message is a reply — who and what it replied to, if that message is still in range. */
  replyTo: { author: string; content: string } | null;
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

const REPLY_SNIPPET_LENGTH = 120;

/**
 * Messages newer than `since`, oldest first, capped at `limit`. Excludes bot messages and
 * soft-deleted messages — a user who deleted a message should not have it land in a public wiki.
 * Left-joins each message's reply target (by discord_id) so reply context isn't dropped even
 * though it's already stored on every row — the target may be outside the query's own window.
 */
export function getUnprocessedMessages(db: Database, guildId: string, since: number, limit: number): WikiSyncMessage[] {
  const rows = db
    .query(
      `SELECT
         m.discord_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_username,
         m.author_display_name, m.content, m.created_at,
         r.author_username AS reply_author_username, r.author_display_name AS reply_author_display_name,
         r.content AS reply_content
       FROM messages m
       LEFT JOIN messages r ON r.discord_id = m.reply_to_id
       WHERE m.guild_id = ? AND m.created_at > ? AND m.deleted_at IS NULL AND m.is_bot = 0
       ORDER BY m.created_at ASC
       LIMIT ?`,
    )
    .all(guildId, since, limit) as Array<{
    discord_id: string;
    channel_id: string;
    parent_channel_id: string | null;
    author_id: string;
    author_username: string;
    author_display_name: string | null;
    content: string;
    created_at: number;
    reply_author_username: string | null;
    reply_author_display_name: string | null;
    reply_content: string | null;
  }>;

  return rows.map((r) => ({
    discordId: r.discord_id,
    channelId: r.channel_id,
    parentChannelId: r.parent_channel_id,
    authorId: r.author_id,
    authorUsername: r.author_username,
    authorDisplayName: r.author_display_name,
    content: r.content,
    createdAt: r.created_at,
    replyTo: r.reply_content
      ? {
          author: r.reply_author_display_name ?? r.reply_author_username ?? "unknown",
          content:
            r.reply_content.length > REPLY_SNIPPET_LENGTH ? `${r.reply_content.slice(0, REPLY_SNIPPET_LENGTH)}…` : r.reply_content,
        }
      : null,
  }));
}
