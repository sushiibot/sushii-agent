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
      `SELECT discord_id, guild_id, channel_id, author_id,
              author_username, author_display_name, content, reply_to_id,
              created_at, edited_at, deleted_at, is_automod
       FROM messages
       WHERE channel_id = ? AND guild_id = ? AND id <= ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(anchor.channel_id, args.guildId, anchor.id, window + 1);

  const after = db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT discord_id, guild_id, channel_id, author_id,
              author_username, author_display_name, content, reply_to_id,
              created_at, edited_at, deleted_at, is_automod
       FROM messages
       WHERE channel_id = ? AND guild_id = ? AND id > ?
       ORDER BY id ASC
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
        `SELECT discord_id, guild_id, channel_id, author_id,
                author_username, author_display_name, content, reply_to_id,
                created_at, edited_at, deleted_at, is_automod
         FROM messages WHERE discord_id IN (${placeholders})`,
      )
      .all(...toFetch);

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
