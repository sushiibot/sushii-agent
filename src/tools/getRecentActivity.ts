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
  content: string;
  reply_to_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export function getRecentActivity(args: GetRecentActivityArgs): MessageRow[] {
  const db = getDb();
  const days = args.days ?? 7;
  const limit = Math.min(args.limit ?? 50, 200);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  return db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT discord_id, guild_id, channel_id, author_id, content, reply_to_id,
              created_at, edited_at, deleted_at
       FROM messages
       WHERE guild_id = ? AND author_id = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(args.guildId, args.user_id, since, limit);
}
