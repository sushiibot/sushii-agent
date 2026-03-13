import { getDb } from "../db/index.ts";

interface SearchMessagesArgs {
  query?: string;
  guildId: string; // injected by runner, never from LLM
  user_ids?: string[];
  channel_id?: string;
  since?: number;
  until?: number;
  limit?: number;
  is_automod?: boolean;
  include_bots?: boolean;
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
  is_bot: number;
}

export function searchMessages(args: SearchMessagesArgs): MessageRow[] | { error: string } {
  const db = getDb();
  const limit = Math.min(args.limit ?? 50, 200);

  if (args.query) {
    // FTS path — ranked by relevance
    let sql = `
      SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
             m.author_username, m.author_display_name, m.content,
             m.reply_to_id, m.created_at, m.edited_at, m.deleted_at, m.is_automod, m.is_bot
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      WHERE messages_fts MATCH ?
        AND m.guild_id = ?
    `;
    const params: (string | number)[] = [args.query, args.guildId];

    if (args.user_ids?.length) {
      sql += ` AND m.author_id IN (${args.user_ids.map(() => "?").join(", ")})`;
      params.push(...args.user_ids);
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
    if (args.is_automod !== undefined) {
      sql += " AND m.is_automod = ?";
      params.push(args.is_automod ? 1 : 0);
    }
    if (!args.include_bots) {
      sql += " AND m.is_bot = 0";
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    try {
      return db.prepare<MessageRow, (string | number)[]>(sql).all(...params);
    } catch (err) {
      return { error: `FTS query failed: ${err}` };
    }
  } else {
    // Browse path — no text query, ordered by recency
    let sql = `
      SELECT discord_id, guild_id, channel_id, author_id,
             author_username, author_display_name, content,
             reply_to_id, created_at, edited_at, deleted_at, is_automod, is_bot
      FROM messages
      WHERE guild_id = ?
    `;
    const params: (string | number)[] = [args.guildId];

    if (args.user_ids?.length) {
      sql += ` AND author_id IN (${args.user_ids.map(() => "?").join(", ")})`;
      params.push(...args.user_ids);
    }
    if (args.channel_id) {
      sql += " AND channel_id = ?";
      params.push(args.channel_id);
    }
    if (args.since !== undefined) {
      sql += " AND created_at >= ?";
      params.push(args.since);
    }
    if (args.until !== undefined) {
      sql += " AND created_at <= ?";
      params.push(args.until);
    }
    if (args.is_automod !== undefined) {
      sql += " AND is_automod = ?";
      params.push(args.is_automod ? 1 : 0);
    }
    if (!args.include_bots) {
      sql += " AND is_bot = 0";
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    return db.prepare<MessageRow, (string | number)[]>(sql).all(...params);
  }
}
