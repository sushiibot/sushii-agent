import { z } from "zod";
import { ChannelType } from "discord.js";
import type { Client, GuildTextBasedChannel } from "discord.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fetchChannelMessages } from "../../tools/fetchChannelMessages.ts";
import { searchMessages } from "../../tools/searchMessages.ts";
import type { McpSession } from "./session.ts";
import type { WebhookCache } from "./webhooks.ts";

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Resolves a caller-supplied channel_id and rejects if its guild isn't in the caller's permitted set. */
async function resolveGuildChannel(
  client: Client<true>,
  channelId: string,
  permittedGuildIds: string[],
): Promise<{ channel: GuildTextBasedChannel } | { error: string }> {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    return { error: `Failed to fetch channel: ${err}` };
  }
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return { error: `Channel ${channelId} is not a guild text channel` };
  }
  if (!permittedGuildIds.includes(channel.guildId)) {
    return { error: `Channel ${channelId} is not in a guild you're authorized for` };
  }
  return { channel };
}

const TEXT_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

export const LIST_CHANNELS_INPUT = z.object({
  guild_id: z.string().optional(),
});
export type McpListChannelsArgs = z.infer<typeof LIST_CHANNELS_INPUT>;

/** Lists the caller's permitted guilds and their text-capable channels — doesn't include threads. */
export function mcpListChannels(client: Client<true>, session: McpSession, args: McpListChannelsArgs): CallToolResult {
  if (args.guild_id && !session.permittedGuildIds.includes(args.guild_id)) {
    return errorResult(`Guild ${args.guild_id} is not one you're authorized for`);
  }
  const guildIds = args.guild_id ? [args.guild_id] : session.permittedGuildIds;

  const guilds = guildIds.map((guildId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return { guild_id: guildId, name: null, channels: [] };
    const channels = guild.channels.cache
      .filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
      .map((channel) => ({ channel_id: channel.id, name: channel.name, type: ChannelType[channel.type] }));
    return { guild_id: guild.id, name: guild.name, channels };
  });

  return textResult(guilds);
}

export const FETCH_INPUT = z.object({
  channel_id: z.string(),
  message_id: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  around: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type McpFetchArgs = z.infer<typeof FETCH_INPUT>;

export async function mcpFetch(
  client: Client<true>,
  session: McpSession,
  args: McpFetchArgs,
  fetchFn: typeof fetchChannelMessages = fetchChannelMessages,
): Promise<CallToolResult> {
  const resolved = await resolveGuildChannel(client, args.channel_id, session.permittedGuildIds);
  if ("error" in resolved) return errorResult(resolved.error);

  const result = await fetchFn({
    ...args,
    client,
    guildId: resolved.channel.guildId,
  });
  if ("error" in result) return errorResult(result.error);
  return textResult(result);
}

export const SEARCH_INPUT = z.object({
  guild_id: z.string(),
  query: z.string().optional(),
  user_ids: z.array(z.string()).optional(),
  channel_id: z.string().optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_bots: z.boolean().optional(),
});
export type McpSearchArgs = z.infer<typeof SEARCH_INPUT>;

export function mcpSearch(
  session: McpSession,
  args: McpSearchArgs,
  searchFn: typeof searchMessages = searchMessages,
): CallToolResult {
  const { guild_id, ...narrowing } = args;
  if (!session.permittedGuildIds.includes(guild_id)) {
    return errorResult(`Guild ${guild_id} is not one you're authorized for`);
  }

  const requestedLimit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const result = searchFn({
    ...narrowing,
    guildId: guild_id,
    // Over-fetch since deleted rows get dropped below — otherwise a caller asking for N
    // could silently get fewer than N with no indication more results exist.
    limit: Math.min(requestedLimit * 2, 100),
    // Forced regardless of caller input — moderation-internal, never exposed to the bridge.
    is_automod: false,
  });
  if ("error" in result) return errorResult(result.error);

  // This is the sole point that hides deleted content: searchMessages's SQL never filters
  // on deleted_at, and reply_to_content/reply_to_author_id come from an unfiltered LEFT JOIN,
  // so they can surface a deleted or automod-flagged parent message even when the row itself
  // passes every check above. Keep both checks here rather than in a shared utility, since
  // this is the only place enforcing them.
  const filtered = result
    .filter((row) => row.deleted_at === null)
    .slice(0, requestedLimit)
    .map(({ reply_to_content: _replyToContent, reply_to_author_id: _replyToAuthorId, ...row }) => row);
  return textResult(filtered);
}

// No name/avatar/identity-shaped or file/attachment field — identity always comes from the
// caller's session, never from tool input, and attachments aren't supported in this version.
export const SEND_INPUT = z.object({
  channel_id: z.string(),
  content: z.string(),
});
export type McpSendArgs = z.infer<typeof SEND_INPUT>;

export async function mcpSend(
  client: Client<true>,
  webhookCache: WebhookCache,
  session: McpSession,
  args: McpSendArgs,
): Promise<CallToolResult> {
  const resolved = await resolveGuildChannel(client, args.channel_id, session.permittedGuildIds);
  if ("error" in resolved) return errorResult(resolved.error);

  try {
    await webhookCache.send(client, resolved.channel, args.content, session.identity);
  } catch (err) {
    return errorResult(`Failed to send message: ${err}`);
  }
  return textResult({ sent: true });
}
