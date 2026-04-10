import { getDb } from "../db/index.ts";

interface GetConversationContextArgs {
  message_id: string;
  guildId: string; // injected by runner
  window?: number;
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

export function getConversationContext(
  args: GetConversationContextArgs,
): MessageRow[] | { error: string } {
  const db = getDb();
  const window = args.window ?? 10;

  const anchor = db
    .query<{ id: number; channel_id: string; created_at: number }, [string]>(
      "SELECT id, channel_id, created_at FROM messages WHERE discord_id = ?",
    )
    .get(args.message_id);

  if (!anchor) {
    return {
      error: `Message ${args.message_id} not found in 30-day cache. Call fetch_channel_messages with around="${args.message_id}" on the channel from the message link to retrieve it from the Discord API.`,
    };
  }

  // Get N messages before (inclusive of anchor) and N after in the same channel
  // Use id-based ordering to avoid duplicates when multiple messages share the same timestamp
  const before = db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
              m.author_username, m.author_display_name, m.content, m.reply_to_id,
              m.created_at, m.edited_at, m.deleted_at, m.is_automod,
              p.content AS reply_to_content,
              p.author_id AS reply_to_author_id
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id
       WHERE m.channel_id = ? AND m.guild_id = ? AND m.id <= ?
       ORDER BY m.id DESC
       LIMIT ?`,
    )
    .all(anchor.channel_id, args.guildId, anchor.id, window + 1);

  const after = db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
              m.author_username, m.author_display_name, m.content, m.reply_to_id,
              m.created_at, m.edited_at, m.deleted_at, m.is_automod,
              p.content AS reply_to_content,
              p.author_id AS reply_to_author_id
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id
       WHERE m.channel_id = ? AND m.guild_id = ? AND m.id > ?
       ORDER BY m.id ASC
       LIMIT ?`,
    )
    .all(anchor.channel_id, args.guildId, anchor.id, window);

  const contextMessages = [...before.reverse(), ...after];

  // Recursively fetch reply chain parents until all chains are resolved or depth limit hit
  const existingIds = new Set(contextMessages.map((m) => m.discord_id));
  let toFetch = contextMessages
    .filter((m) => m.reply_to_id && !existingIds.has(m.reply_to_id))
    .map((m) => m.reply_to_id as string);

  const maxDepth = 10;
  let depth = 0;
  while (toFetch.length > 0 && depth < maxDepth) {
    const placeholders = toFetch.map(() => "?").join(",");
    const parents = db
      .prepare<MessageRow, string[]>(
        `SELECT m.discord_id, m.guild_id, m.channel_id, m.author_id,
                m.author_username, m.author_display_name, m.content, m.reply_to_id,
                m.created_at, m.edited_at, m.deleted_at, m.is_automod,
                p.content AS reply_to_content,
                p.author_id AS reply_to_author_id
         FROM messages m
         LEFT JOIN messages p ON m.reply_to_id = p.discord_id AND m.guild_id = p.guild_id
         WHERE m.discord_id IN (${placeholders}) AND m.guild_id = ?`,
      )
      .all(...toFetch, args.guildId);

    const nextFetch: string[] = [];
    for (const p of parents) {
      if (!existingIds.has(p.discord_id)) {
        contextMessages.push(p);
        existingIds.add(p.discord_id);
        if (p.reply_to_id && !existingIds.has(p.reply_to_id)) {
          nextFetch.push(p.reply_to_id);
        }
      }
    }
    toFetch = nextFetch;
    depth++;
  }

  return contextMessages.sort((a, b) => a.created_at - b.created_at);
}
