import { makeURLSearchParams } from "@discordjs/rest";
import type { Client } from "discord.js";

interface SearchGuildMessagesArgs {
  guildId: string; // injected by runner, never from LLM
  client: Client<true>; // injected by runner
  content?: string;
  author_id?: string;
  channel_id?: string;
  has?: string;
  limit?: number;
  offset?: number;
  sort_by?: "timestamp" | "relevance";
  sort_order?: "asc" | "desc";
}

interface APIMessageAuthor {
  id: string;
  username: string;
  global_name?: string | null;
}

interface APIMessage {
  id: string;
  channel_id: string;
  author: APIMessageAuthor;
  content: string;
  timestamp: string;
  referenced_message?: APIMessage | null;
}

interface SearchResponse {
  total_results: number;
  // Each inner array is the matched message + context; first element is the match.
  messages: APIMessage[][];
  doing_deep_historical_index?: boolean;
}

export interface SearchGuildMessagesResult {
  total_results: number;
  messages: {
    discord_id: string;
    channel_id: string;
    author_id: string;
    author_username: string | null;
    author_display_name: string | null;
    content: string;
    reply_to_id: string | null;
    created_at: number;
    reply_to_content: string | null;
    reply_to_author_id: string | null;
  }[];
}

export async function searchGuildMessages(
  args: SearchGuildMessagesArgs,
): Promise<SearchGuildMessagesResult | { error: string }> {
  try {
    const query: Record<string, string | number> = {};
    if (args.content) query.content = args.content;
    if (args.author_id) query.author_id = args.author_id;
    if (args.channel_id) query.channel_id = args.channel_id;
    if (args.has) query.has = args.has;
    if (args.limit) query.limit = args.limit;
    if (args.offset) query.offset = args.offset;
    if (args.sort_by) query.sort_by = args.sort_by;
    if (args.sort_order) query.sort_order = args.sort_order;

    const data = (await args.client.rest.get(`/guilds/${args.guildId}/messages/search`, {
      query: makeURLSearchParams(query),
    })) as SearchResponse;

    if (data.doing_deep_historical_index) {
      return { error: "Discord is still indexing this server's messages. Try again shortly." };
    }

    const messages = data.messages.map((group) => {
      const msg = group[0];
      const ref = msg.referenced_message ?? null;
      return {
        discord_id: msg.id,
        channel_id: msg.channel_id,
        author_id: msg.author.id,
        author_username: msg.author.username ?? null,
        author_display_name: msg.author.global_name ?? null,
        content: msg.content,
        reply_to_id: ref?.id ?? null,
        created_at: new Date(msg.timestamp).getTime(),
        reply_to_content: ref?.content ?? null,
        reply_to_author_id: ref?.author.id ?? null,
      };
    });

    return { total_results: data.total_results, messages };
  } catch (err) {
    return { error: `Search failed: ${err}` };
  }
}
