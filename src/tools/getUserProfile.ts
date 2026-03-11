import { getDb } from "../db/index.ts";

interface GetUserProfileArgs {
  user_id: string;
  guildId: string; // injected by runner
}

export function getUserProfile(args: GetUserProfileArgs) {
  const db = getDb();

  const summary = db
    .query<
      {
        first_seen: number | null;
        last_seen: number | null;
        total_messages: number;
        channel_count: number;
      },
      [string, string]
    >(
      `SELECT MIN(created_at) as first_seen, MAX(created_at) as last_seen,
              COUNT(*) as total_messages, COUNT(DISTINCT channel_id) as channel_count
       FROM messages
       WHERE guild_id = ? AND author_id = ? AND deleted_at IS NULL`,
    )
    .get(args.guildId, args.user_id);

  const channelDistribution = db
    .prepare<{ channel_id: string; count: number }, [string, string]>(
      `SELECT channel_id, COUNT(*) as count
       FROM messages
       WHERE guild_id = ? AND author_id = ? AND deleted_at IS NULL
       GROUP BY channel_id
       ORDER BY count DESC
       LIMIT 10`,
    )
    .all(args.guildId, args.user_id);

  const dailyActivity = db
    .prepare<{ day: string; count: number }, [string, string]>(
      `SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as count
       FROM messages
       WHERE guild_id = ? AND author_id = ? AND deleted_at IS NULL
       GROUP BY day
       ORDER BY day DESC
       LIMIT 30`,
    )
    .all(args.guildId, args.user_id);

  return { summary, channelDistribution, dailyActivity };
}
