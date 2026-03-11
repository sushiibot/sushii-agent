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
  content: string;
  reply_to_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
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
    return { error: `Message ${args.message_id} not found in cache` };
  }

  // Get N messages before (inclusive of anchor) and N after in the same channel
  const before = db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT discord_id, guild_id, channel_id, author_id, content, reply_to_id,
              created_at, edited_at, deleted_at
       FROM messages
       WHERE channel_id = ? AND guild_id = ? AND created_at <= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(anchor.channel_id, args.guildId, anchor.created_at, window + 1);

  const after = db
    .prepare<MessageRow, [string, string, number, number]>(
      `SELECT discord_id, guild_id, channel_id, author_id, content, reply_to_id,
              created_at, edited_at, deleted_at
       FROM messages
       WHERE channel_id = ? AND guild_id = ? AND created_at > ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(anchor.channel_id, args.guildId, anchor.created_at, window);

  const contextMessages = [...before.reverse(), ...after];

  // Fetch reply chain parents that aren't already in the window
  const existingIds = new Set(contextMessages.map((m) => m.discord_id));
  const replyParentIds = contextMessages
    .filter((m) => m.reply_to_id && !existingIds.has(m.reply_to_id))
    .map((m) => m.reply_to_id as string);

  if (replyParentIds.length > 0) {
    const placeholders = replyParentIds.map(() => "?").join(",");
    const parents = db
      .prepare<MessageRow, string[]>(
        `SELECT discord_id, guild_id, channel_id, author_id, content, reply_to_id,
                created_at, edited_at, deleted_at
         FROM messages WHERE discord_id IN (${placeholders})`,
      )
      .all(...replyParentIds);

    for (const p of parents) {
      if (!existingIds.has(p.discord_id)) {
        contextMessages.push(p);
        existingIds.add(p.discord_id);
      }
    }
  }

  return contextMessages.sort((a, b) => a.created_at - b.created_at);
}
