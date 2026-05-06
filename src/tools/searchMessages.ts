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
  reply_to_content: string | null;
  reply_to_author_id: string | null;
}

export function searchMessages(args: SearchMessagesArgs): MessageRow[] | { error: string } {
  const db = getDb();
  const limit = Math.min(args.limit ?? 20, 100);

  if (args.query) {
    // Auto-prefix-wrap bare terms so "shelf" also matches "shelved", "shelving" etc.
    // Only applies when the query has no FTS5 operators or special syntax — if the
    // caller already used *, OR, NEAR, NOT, or quotes, leave it as-is.
    const hasFtsOperators = /[*"()]|\bOR\b|\bAND\b|\bNOT\b|\bNEAR\b/i.test(args.query);
    let ftsQuery: string;
    if (hasFtsOperators) {
      ftsQuery = args.query;
    } else {
      // Strip common stop words — they produce enormous FTS5 posting lists and make
      // multi-word queries pathologically slow (e.g. "my*" matches millions of rows).
      // If stripping leaves nothing, fall back to the original terms.
      const STOP_WORDS = new Set([
        "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "my", "your", "his",
        "her", "its", "our", "their", "this", "that", "i", "you", "he", "she",
        "it", "we", "they", "me", "him", "us", "them", "what", "who", "not",
        "no", "so", "if", "as", "up", "can", "will", "just", "all", "any",
      ]);
      const terms = args.query.trim().split(/\s+/);
      const significant = terms.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
      const effective = significant.length > 0 ? significant : terms;
      // Only prefix-wrap tokens ≥3 chars — short tokens as exact-match are much faster
      ftsQuery = effective.map((t) => (t.length >= 3 ? `${t}*` : t)).join(" ");
    }

    // FTS path — ranked by relevance
    let sql = `
      SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
             m.author_username, m.author_display_name, m.content,
             m.reply_to_id, m.created_at, m.edited_at, m.deleted_at, m.is_automod, m.is_bot,
             p.content AS reply_to_content,
             p.author_id AS reply_to_author_id
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id
      WHERE messages_fts MATCH ?
        AND m.guild_id = ?
    `;
    const params: (string | number)[] = [ftsQuery, args.guildId];

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
      SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
             m.author_username, m.author_display_name, m.content,
             m.reply_to_id, m.created_at, m.edited_at, m.deleted_at, m.is_automod, m.is_bot,
             p.content AS reply_to_content,
             p.author_id AS reply_to_author_id
      FROM messages m
      LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id
      WHERE m.guild_id = ?
    `;
    const params: (string | number)[] = [args.guildId];

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

    sql += " ORDER BY m.created_at DESC LIMIT ?";
    params.push(limit);

    return db.prepare<MessageRow, (string | number)[]>(sql).all(...params);
  }
}
