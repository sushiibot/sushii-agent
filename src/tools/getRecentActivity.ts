import { getDb } from "../db/index.ts";

interface GetRecentActivityArgs {
  user_id: string;
  guildId: string; // injected by runner
  days?: number;
  limit?: number;
}

interface MessageRow {
  discord_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  author_username: string | null;
  author_display_name: string | null;
  content: string;
  reply_to_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  is_automod: number;
  reply_to_content: string | null;
  reply_to_author_id: string | null;
}

export function getRecentActivity(args: GetRecentActivityArgs): MessageRow[] {
  const db = getDb();
  const days = args.days ?? 7;
  const limit = Math.min(args.limit ?? 15, 200);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  return db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
              m.author_username, m.author_display_name, m.content, m.reply_to_id,
              m.created_at, m.edited_at, m.deleted_at, m.is_automod,
              p.content AS reply_to_content,
              p.author_id AS reply_to_author_id
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id
       WHERE m.guild_id = ? AND m.author_id = ? AND m.created_at >= ?
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(args.guildId, args.user_id, since, limit);
}
