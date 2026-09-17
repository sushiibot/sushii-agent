// Concrete MessageCacheHost — reads the SQLite message cache directly. Ports
// src/tools/{searchMessages,getConversationContext,getRecentActivity,resolveUsersByName,
// getUserProfile}.ts.
//
// findDeletableMessages also carries a discord.js Client for the live-API fallback the old
// delete_user_messages.ts had (cache thinner than 5 hits → supplement from the live channel):
// the frozen MessageCacheHost interface (contracts.ts §7) doesn't expose that dependency, but
// nothing stops a concrete implementation from holding one. This keeps DiscordHost.
// deleteMemberMessages (contracts.ts's actual member — there's no `findDeletable` on it) a pure
// deletion step over pre-selected candidates, matching the two-host split the tool entry
// (core/tools/discord/deleteUserMessages.ts) already assumes.
import type { Client } from "discord.js";
import type { Database } from "bun:sqlite";
import "../../../core/tools/hosts.ts";
import type { DiscordMessageResult } from "../../../core/tools/hosts.ts";

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

type MessageRowWithBot = MessageRow & { is_bot: number };

function toDiscordMessageResult(row: MessageRow): DiscordMessageResult & {
  deletedAt: number | null;
  isAutomod: boolean;
  replyToContent: string | null;
  replyToAuthorId: string | null;
} {
  return {
    discordId: row.discord_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorUsername: row.author_username,
    authorDisplayName: row.author_display_name,
    content: row.content,
    replyToId: row.reply_to_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    isAutomod: row.is_automod === 1,
    replyToContent: row.reply_to_content,
    replyToAuthorId: row.reply_to_author_id,
  };
}

const MESSAGE_ROW_SELECT = `m.discord_id, m.guild_id, m.channel_id, m.author_id,
       m.author_username, m.author_display_name, m.content, m.reply_to_id,
       m.created_at, m.edited_at, m.deleted_at, m.is_automod,
       p.content AS reply_to_content,
       p.author_id AS reply_to_author_id`;
const MESSAGE_ROW_JOIN = "LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id";

export class DiscordMessageCacheHost {
  constructor(
    private readonly db: Database,
    private readonly guildId: string,
    private readonly client?: Client<true>,
  ) {}

  searchMessages(args: {
    query?: string; userIds?: string[]; channelId?: string; since?: number; until?: number;
    limit?: number; isAutomod?: boolean; includeBots?: boolean;
  }): DiscordMessageResult[] | { error: string } {
    const limit = Math.min(args.limit ?? 20, 100);

    if (args.query) {
      let sql = `
        SELECT ${MESSAGE_ROW_SELECT}, m.is_bot
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        ${MESSAGE_ROW_JOIN}
        WHERE messages_fts MATCH ?
          AND m.guild_id = ?
      `;
      const params: (string | number)[] = [args.query, this.guildId];

      if (args.userIds?.length) {
        sql += ` AND m.author_id IN (${args.userIds.map(() => "?").join(", ")})`;
        params.push(...args.userIds);
      }
      if (args.channelId) { sql += " AND m.channel_id = ?"; params.push(args.channelId); }
      if (args.since !== undefined) { sql += " AND m.created_at >= ?"; params.push(args.since); }
      if (args.until !== undefined) { sql += " AND m.created_at <= ?"; params.push(args.until); }
      if (args.isAutomod !== undefined) { sql += " AND m.is_automod = ?"; params.push(args.isAutomod ? 1 : 0); }
      if (!args.includeBots) sql += " AND m.is_bot = 0";
      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);

      try {
        const rows = this.db.prepare<MessageRowWithBot, (string | number)[]>(sql).all(...params);
        return rows.map(toDiscordMessageResult);
      } catch (err) {
        return { error: `FTS query failed: ${err}` };
      }
    }

    let sql = `
      SELECT ${MESSAGE_ROW_SELECT}, m.is_bot
      FROM messages m
      ${MESSAGE_ROW_JOIN}
      WHERE m.guild_id = ?
    `;
    const params: (string | number)[] = [this.guildId];
    if (args.userIds?.length) {
      sql += ` AND m.author_id IN (${args.userIds.map(() => "?").join(", ")})`;
      params.push(...args.userIds);
    }
    if (args.channelId) { sql += " AND m.channel_id = ?"; params.push(args.channelId); }
    if (args.since !== undefined) { sql += " AND m.created_at >= ?"; params.push(args.since); }
    if (args.until !== undefined) { sql += " AND m.created_at <= ?"; params.push(args.until); }
    if (args.isAutomod !== undefined) { sql += " AND m.is_automod = ?"; params.push(args.isAutomod ? 1 : 0); }
    if (!args.includeBots) sql += " AND m.is_bot = 0";
    sql += " ORDER BY m.created_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare<MessageRowWithBot, (string | number)[]>(sql).all(...params);
    return rows.map(toDiscordMessageResult);
  }

  getConversationContext(args: { messageId: string; window?: number }): DiscordMessageResult[] | { error: string } {
    const window = args.window ?? 10;

    const anchor = this.db
      .query<{ id: number; channel_id: string; created_at: number }, [string]>(
        "SELECT id, channel_id, created_at FROM messages WHERE discord_id = ?",
      )
      .get(args.messageId);

    if (!anchor) {
      return {
        error: `Message ${args.messageId} not found in 30-day cache. Call fetch_channel_messages with around="${args.messageId}" on the channel from the message link to retrieve it from the Discord API.`,
      };
    }

    const before = this.db
      .prepare<MessageRow, [string, string, number, number]>(
        `SELECT ${MESSAGE_ROW_SELECT}
         FROM messages m
         ${MESSAGE_ROW_JOIN}
         WHERE m.channel_id = ? AND m.guild_id = ? AND m.id <= ?
         ORDER BY m.id DESC
         LIMIT ?`,
      )
      .all(anchor.channel_id, this.guildId, anchor.id, window + 1);

    const after = this.db
      .prepare<MessageRow, [string, string, number, number]>(
        `SELECT ${MESSAGE_ROW_SELECT}
         FROM messages m
         ${MESSAGE_ROW_JOIN}
         WHERE m.channel_id = ? AND m.guild_id = ? AND m.id > ?
         ORDER BY m.id ASC
         LIMIT ?`,
      )
      .all(anchor.channel_id, this.guildId, anchor.id, window);

    const contextMessages = [...before.reverse(), ...after];

    const existingIds = new Set(contextMessages.map((m) => m.discord_id));
    let toFetch = contextMessages
      .filter((m) => m.reply_to_id && !existingIds.has(m.reply_to_id))
      .map((m) => m.reply_to_id as string);

    const maxDepth = 10;
    let depth = 0;
    while (toFetch.length > 0 && depth < maxDepth) {
      const placeholders = toFetch.map(() => "?").join(",");
      const parents = this.db
        .prepare<MessageRow, string[]>(
          `SELECT ${MESSAGE_ROW_SELECT}
           FROM messages m
           ${MESSAGE_ROW_JOIN}
           WHERE m.discord_id IN (${placeholders}) AND m.guild_id = ?`,
        )
        .all(...toFetch, this.guildId);

      const nextFetch: string[] = [];
      for (const p of parents) {
        if (!existingIds.has(p.discord_id)) {
          contextMessages.push(p);
          existingIds.add(p.discord_id);
          if (p.reply_to_id && !existingIds.has(p.reply_to_id)) nextFetch.push(p.reply_to_id);
        }
      }
      toFetch = nextFetch;
      depth++;
    }

    return contextMessages.sort((a, b) => a.created_at - b.created_at).map(toDiscordMessageResult);
  }

  getUserProfile(userId: string) {
    const summary = this.db
      .query<{ first_seen: number | null; last_seen: number | null; total_messages: number; channel_count: number }, [string, string]>(
        `SELECT MIN(created_at) as first_seen, MAX(created_at) as last_seen,
                COUNT(*) as total_messages, COUNT(DISTINCT channel_id) as channel_count
         FROM messages
         WHERE guild_id = ? AND author_id = ? AND deleted_at IS NULL`,
      )
      .get(this.guildId, userId);

    const channelDistribution = this.db
      .prepare<{ channel_id: string; count: number }, [string, string]>(
        `SELECT channel_id, COUNT(*) as count
         FROM messages
         WHERE guild_id = ? AND author_id = ? AND deleted_at IS NULL
         GROUP BY channel_id
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all(this.guildId, userId);

    const dailyActivity = this.db
      .prepare<{ day: string; count: number }, [string, string]>(
        `SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as count
         FROM messages
         WHERE guild_id = ? AND author_id = ? AND deleted_at IS NULL
         GROUP BY day
         ORDER BY day DESC
         LIMIT 30`,
      )
      .all(this.guildId, userId);

    return { summary, channelDistribution, dailyActivity };
  }

  getRecentActivity(args: { userId: string; days?: number; limit?: number }): DiscordMessageResult[] {
    const days = args.days ?? 7;
    const limit = Math.min(args.limit ?? 15, 200);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const rows = this.db
      .prepare<MessageRow, [string, string, number, number]>(
        `SELECT ${MESSAGE_ROW_SELECT}
         FROM messages m
         ${MESSAGE_ROW_JOIN}
         WHERE m.guild_id = ? AND m.author_id = ? AND m.created_at >= ?
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(this.guildId, args.userId, since, limit);

    return rows.map(toDiscordMessageResult);
  }

  resolveUsersByName(args: { name: string; days?: number; limit?: number }) {
    const days = args.days ?? 30;
    const limit = Math.min(args.limit ?? 10, 25);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const escapedName = args.name.replace(/[%_\\]/g, "\\$&");
    const pattern = `%${escapedName}%`;

    return this.db
      .prepare<
        { author_id: string; author_username: string | null; author_display_name: string | null; last_active: number; message_count: number },
        [string, number, string, string, number]
      >(
        `SELECT author_id, author_username, author_display_name,
                MAX(created_at) AS last_active, COUNT(*) AS message_count
         FROM messages
         WHERE guild_id = ?
           AND created_at >= ?
           AND (author_username LIKE ? ESCAPE '\\' OR author_display_name LIKE ? ESCAPE '\\')
         GROUP BY author_id
         ORDER BY last_active DESC
         LIMIT ?`,
      )
      .all(this.guildId, since, pattern, pattern, limit);
  }

  /**
   * Selects deletion candidates from the cache. NOTE: contracts.ts's MessageCacheHost.
   * findDeletableMessages is synchronous, so the old deleteUserMessages.ts's live-API
   * supplement (fetch the channel's last 100 messages when the cache has <5 hits) can't run
   * here without a signature change — that fallback needs `await channel.messages.fetch(...)`.
   * `prefetchLiveCandidates` below does the live fetch; the tool entry that constructs this host
   * must call it once (awaited) before dispatching the turn's tools if it wants the fallback —
   * flagging this rather than papering over it, since the two-host split in
   * core/tools/discord/deleteUserMessages.ts currently has no async hook point for it.
   */
  findDeletableMessages(args: { userId: string; channelId: string; limit: number }): { discord_id: string; content: string; created_at: number }[] {
    const cached = this.searchMessages({ userIds: [args.userId], channelId: args.channelId, limit: args.limit });
    const rows: { discord_id: string; content: string; created_at: number }[] = Array.isArray(cached)
      ? cached.map((r) => ({ discord_id: r.discordId, content: r.content, created_at: r.createdAt }))
      : [];
    return rows.slice(0, args.limit);
  }

  /** The live-API fallback restored from src/tools/deleteUserMessages.ts, callable ahead of a
   *  synchronous findDeletableMessages lookup once cache thinness is known (<5 hits). */
  async prefetchLiveCandidates(userId: string, channelId: string): Promise<{ discord_id: string; content: string; created_at: number }[]> {
    if (!this.client) return [];
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return [];
      const fetched = await channel.messages.fetch({ limit: 100 });
      const rows: { discord_id: string; content: string; created_at: number }[] = [];
      for (const [id, msg] of fetched) {
        if (msg.author.id === userId) rows.push({ discord_id: id, content: msg.content, created_at: msg.createdTimestamp });
      }
      return rows;
    } catch {
      return [];
    }
  }
}
