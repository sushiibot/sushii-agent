import { getDb } from "../db/index.ts";

interface SearchMessagesArgs {
  query: string;
  guildId: string; // injected by runner, never from LLM
  user_id?: string;
  channel_id?: string;
  since?: number;
  until?: number;
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

export function searchMessages(args: SearchMessagesArgs): MessageRow[] | { error: string } {
  const db = getDb();
  const limit = Math.min(args.limit ?? 20, 100);

  let sql = `
    SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id, m.content,
           m.reply_to_id, m.created_at, m.edited_at, m.deleted_at
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    WHERE messages_fts MATCH ?
      AND m.guild_id = ?
  `;
  const params: (string | number)[] = [args.query, args.guildId];

  if (args.user_id) {
    sql += " AND m.author_id = ?";
    params.push(args.user_id);
  }
  if (args.channel_id) {
    sql += " AND m.channel_id = ?";
    params.push(args.channel_id);
  }
  if (args.since !== undefined) {
    sql += " AND m.created_at >= ?";
    params.push(args.since);
  }
  if (args.until !== undefined) {
    sql += " AND m.created_at <= ?";
    params.push(args.until);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  try {
    return db.prepare<MessageRow, (string | number)[]>(sql).all(...params);
  } catch (err) {
    return { error: `FTS query failed: ${err}` };
  }
}
