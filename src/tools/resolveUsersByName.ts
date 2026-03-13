import { getDb } from "../db/index.ts";

interface ResolveUsersByNameArgs {
  name: string;
  guildId: string; // injected by runner
  days?: number;
  limit?: number;
}

interface UserCandidate {
  author_id: string;
  author_username: string | null;
  author_display_name: string | null;
  last_active: number;
  message_count: number;
}

export function resolveUsersByName(args: ResolveUsersByNameArgs): UserCandidate[] {
  const db = getDb();
  const days = args.days ?? 30;
  const limit = Math.min(args.limit ?? 10, 25);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const pattern = `%${args.name}%`;

  return db
    .prepare<UserCandidate, [string, number, string, string]>(
      `SELECT author_id, author_username, author_display_name,
              MAX(created_at) AS last_active, COUNT(*) AS message_count
       FROM messages
       WHERE guild_id = ?
         AND created_at >= ?
         AND (author_username LIKE ? OR author_display_name LIKE ?)
       GROUP BY author_id
       ORDER BY last_active DESC
       LIMIT ${limit}`,
    )
    .all(args.guildId, since, pattern, pattern);
}
