import type { Client, GuildTextBasedChannel } from "discord.js";
import { searchMessages } from "./searchMessages.ts";

export interface DeleteUserMessagesArgs {
  user_id: string;
  channel_id: string;
  limit?: number;
  guildId: string;
  client: Client<true>;
}

export interface DeleteUserMessagesResult {
  ok: true;
  requested: number;
  bulkDeleted: number;
  sequentialDeleted: number;
  errors: number;
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

export async function deleteUserMessages(
  args: DeleteUserMessagesArgs,
): Promise<DeleteUserMessagesResult | { error: string }> {
  const limit = Math.min(args.limit ?? 50, 100);

  let channel: GuildTextBasedChannel;
  try {
    const fetched = await args.client.channels.fetch(args.channel_id);
    if (!fetched?.isTextBased() || fetched.isDMBased() || fetched.guildId !== args.guildId) {
      return { error: `Channel ${args.channel_id} is invalid or not in this guild.` };
    }
    channel = fetched as GuildTextBasedChannel;
  } catch (err) {
    return { error: `Failed to fetch channel: ${err}` };
  }

  // Pull message IDs from local cache first
  const cached = searchMessages({ guildId: args.guildId, user_ids: [args.user_id], channel_id: args.channel_id, limit });
  const messageIds: string[] = Array.isArray(cached)
    ? cached.map((r) => r.discord_id)
    : [];

  // API fallback if cache is thin
  if (messageIds.length < 5) {
    try {
      const fetched = await channel.messages.fetch({ limit: 100 });
      for (const [id, msg] of fetched) {
        if (msg.author.id === args.user_id && !messageIds.includes(id)) {
          messageIds.push(id);
        }
      }
    } catch {
      // non-fatal
    }
  }

  const cutoff = Date.now() - FOURTEEN_DAYS_MS;
  const recentIds: string[] = [];
  const oldIds: string[] = [];

  for (const id of messageIds.slice(0, limit)) {
    if (snowflakeToMs(id) >= cutoff) recentIds.push(id);
    else oldIds.push(id);
  }

  let bulkDeleted = 0;
  let sequentialDeleted = 0;
  let errors = 0;

  if (recentIds.length > 0 && "bulkDelete" in channel) {
    try {
      const deleted = await channel.bulkDelete(recentIds, true);
      bulkDeleted = deleted.size;
    } catch {
      // fall through to sequential
      for (const id of recentIds) {
        try {
          const msg = await channel.messages.fetch(id).catch(() => null);
          if (msg) { await msg.delete(); sequentialDeleted++; }
        } catch { errors++; }
      }
    }
  }

  for (const id of oldIds) {
    try {
      const msg = await channel.messages.fetch(id).catch(() => null);
      if (msg) { await msg.delete(); sequentialDeleted++; }
    } catch { errors++; }
  }

  return {
    ok: true,
    requested: messageIds.length,
    bulkDeleted,
    sequentialDeleted,
    errors,
  };
}
