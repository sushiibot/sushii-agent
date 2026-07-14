import type { Client, GuildTextBasedChannel } from "discord.js";
import { searchMessages } from "./searchMessages.ts";

export interface DeleteUserMessagesArgs {
  user_id: string;
  channel_id: string;
  limit?: number;
  guildId: string;
  client: Client<true>;
  dryRun?: boolean;
}

export interface DeletedMessageSummary {
  id: string;
  content: string;
}

export interface DeleteUserMessagesResult {
  ok: true;
  requested: number;
  bulkDeleted: number;
  sequentialDeleted: number;
  errors: number;
  deleted: DeletedMessageSummary[];
  dryRun?: boolean;
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REPORTED_CONTENT = 200;
const MAX_REPORTED_MESSAGES = 25;

function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

function summarize(id: string, contentById: Map<string, string>): DeletedMessageSummary {
  const raw = contentById.get(id) ?? "";
  const content = raw.length > 0 ? raw.slice(0, MAX_REPORTED_CONTENT) : "(no text content — attachment/embed only)";
  return { id, content };
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

  // Pull message IDs (and content, for reporting) from local cache first
  const cached = searchMessages({ guildId: args.guildId, user_ids: [args.user_id], channel_id: args.channel_id, limit });
  const messageIds: string[] = [];
  const contentById = new Map<string, string>();
  if (Array.isArray(cached)) {
    for (const r of cached) {
      messageIds.push(r.discord_id);
      contentById.set(r.discord_id, r.content);
    }
  }

  // API fallback if cache is thin
  if (messageIds.length < 5) {
    try {
      const fetched = await channel.messages.fetch({ limit: 100 });
      for (const [id, msg] of fetched) {
        if (msg.author.id === args.user_id && !contentById.has(id)) {
          messageIds.push(id);
          contentById.set(id, msg.content);
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

  if (args.dryRun) {
    const attempted = [...recentIds, ...oldIds];
    return {
      ok: true,
      requested: messageIds.length,
      bulkDeleted: recentIds.length,
      sequentialDeleted: oldIds.length,
      errors: 0,
      deleted: attempted.slice(0, MAX_REPORTED_MESSAGES).map((id) => summarize(id, contentById)),
      dryRun: true,
    };
  }

  let bulkDeleted = 0;
  let sequentialDeleted = 0;
  let errors = 0;
  const deleted: DeletedMessageSummary[] = [];

  if (recentIds.length > 0 && "bulkDelete" in channel) {
    try {
      const result = await channel.bulkDelete(recentIds, true);
      bulkDeleted = result.size;
      for (const id of result.keys()) deleted.push(summarize(id, contentById));
    } catch {
      // fall through to sequential
      for (const id of recentIds) {
        try {
          const msg = await channel.messages.fetch(id).catch(() => null);
          if (msg) {
            await msg.delete();
            sequentialDeleted++;
            deleted.push(summarize(id, contentById));
          }
        } catch { errors++; }
      }
    }
  }

  for (const id of oldIds) {
    try {
      const msg = await channel.messages.fetch(id).catch(() => null);
      if (msg) {
        await msg.delete();
        sequentialDeleted++;
        deleted.push(summarize(id, contentById));
      }
    } catch { errors++; }
  }

  return {
    ok: true,
    requested: messageIds.length,
    bulkDeleted,
    sequentialDeleted,
    errors,
    deleted: deleted.slice(0, MAX_REPORTED_MESSAGES),
  };
}
