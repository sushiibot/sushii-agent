import type { Client, Message, TextBasedChannel } from "discord.js";
import { buildMessageContent } from "../utils/flattenMessage.ts";

interface FetchChannelMessagesArgs {
  channel_id: string;
  client: Client<true>; // injected by runner
  guildId: string; // injected by runner
  // Single message fetch
  message_id?: string;
  // Range fetch (mutually exclusive)
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}

interface MessageResult {
  discord_id: string;
  channel_id: string;
  author_id: string;
  author_username: string;
  author_display_name: string | null;
  content: string;
  reply_to_id: string | null;
  created_at: number;
  edited_at: number | null;
}

export async function fetchChannelMessages(
  args: FetchChannelMessagesArgs,
): Promise<MessageResult[] | { error: string }> {
  let channel: TextBasedChannel;
  try {
    const fetched = await args.client.channels.fetch(args.channel_id);
    if (!fetched || !fetched.isTextBased()) {
      return { error: `Channel ${args.channel_id} is not a text channel` };
    }
    channel = fetched;
    if ("guildId" in fetched && fetched.guildId !== args.guildId) {
      return { error: `Channel ${args.channel_id} does not belong to this guild` };
    }
  } catch (err) {
    return { error: `Failed to fetch channel: ${err}` };
  }

  const toResult = (m: Message): MessageResult => {
    let content = buildMessageContent(m);
    if (content === "[empty message]") {
      content = "[no readable content — likely a bot embed or media attachment that cannot be retrieved via API]";
    }

    return {
      discord_id: m.id,
      channel_id: m.channelId,
      author_id: m.author.id,
      author_username: m.author.username,
      author_display_name: m.author.displayName !== m.author.username ? m.author.displayName : null,
      content,
      reply_to_id: m.reference?.messageId ?? null,
      created_at: m.createdTimestamp,
      edited_at: m.editedTimestamp,
    };
  };

  try {
    if (args.message_id) {
      const msg = await channel.messages.fetch(args.message_id);
      return [toResult(msg)];
    }

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
    const options: { before?: string; after?: string; around?: string; limit: number } = { limit };
    if (args.before) options.before = args.before;
    else if (args.after) options.after = args.after;
    else if (args.around) options.around = args.around;

    const messages = await channel.messages.fetch(options);
    return [...messages.values()].map(toResult).sort((a, b) => a.created_at - b.created_at);
  } catch (err) {
    return { error: `Failed to fetch messages: ${err}` };
  }
}
