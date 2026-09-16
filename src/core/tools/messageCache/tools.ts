// Ports src/tools/{searchMessages,getConversationContext,getRecentActivity,resolveUsersByName,
// getUserProfile}.ts onto MessageCacheHost. Pure SQLite reads — no discord.js, so the concrete
// host impl could live in core too, but the BRIEF scopes concrete host impls out of U2.
import type { ToolEntry } from "../../contracts.ts";
import "../hosts.ts";
import { formatMessageRows, collectKnownUsersFromRows } from "../format.ts";

function describeQuery(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "search_messages": {
      const filters: string[] = [];
      if (input.query) filters.push(`query "${input.query as string}"`);
      if (input.user_ids) filters.push(`users [${(input.user_ids as string[]).join(", ")}]`);
      if (input.channel_id) filters.push(`c:${input.channel_id as string}`);
      return filters.length > 0 ? filters.join(", ") : "an unfiltered browse of recent messages";
    }
    case "get_conversation_context":
      return `context around msg:${input.message_id as string}`;
    case "get_recent_activity":
      return `u:${input.user_id as string}'s recent activity`;
    default:
      return "the given filters";
  }
}

export const searchMessagesEntry: ToolEntry<"messageCache"> = {
  name: "search_messages",
  definition: {
    name: "search_messages",
    description:
      "Search or browse the server's cached message history (last ~30 days). Provide a query for full-text search ranked by relevance; omit it to browse recent messages by time. Bare terms match exactly; use 'word*' for prefix matching, OR/NOT/NEAR() and phrase quotes are supported.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional FTS5 search query." },
        user_ids: { type: "array", items: { type: "string" }, description: "Filter to messages from these Discord user IDs." },
        channel_id: { type: "string", description: "Filter results to a specific channel ID" },
        since: { type: "number", description: "Return only messages after this Unix timestamp in milliseconds" },
        until: { type: "number", description: "Return only messages before this Unix timestamp in milliseconds" },
        limit: { type: "number", description: "Maximum number of results to return (default: 20, max: 100)" },
        is_automod: { type: "boolean", description: "If true, return only AutoMod alert messages." },
        include_bots: { type: "boolean", description: "If true, include messages from bots. Defaults to false." },
      },
      required: [],
    },
  },
  requiresHosts: ["messageCache"],
  async execute(input, ctx) {
    const raw = ctx.messageCache.searchMessages({
      query: input.query as string | undefined,
      userIds: input.user_ids as string[] | undefined,
      channelId: input.channel_id as string | undefined,
      since: input.since as number | undefined,
      until: input.until as number | undefined,
      limit: input.limit as number | undefined,
      isAutomod: input.is_automod as boolean | undefined,
      includeBots: input.include_bots as boolean | undefined,
    });
    if ("error" in raw) return { content: raw.error };
    collectKnownUsersFromRows(raw, ctx.knownUsers);
    return { content: formatMessageRows(raw, describeQuery("search_messages", input)) };
  },
};

export const getConversationContextEntry: ToolEntry<"messageCache"> = {
  name: "get_conversation_context",
  definition: {
    name: "get_conversation_context",
    description: "Get surrounding context for a specific message — messages before and after it in the same channel, plus reply chain references.",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Discord message ID (snowflake) of the anchor message" },
        window: { type: "number", description: "Number of messages to retrieve before and after the anchor (default: 10)" },
      },
      required: ["message_id"],
    },
  },
  requiresHosts: ["messageCache"],
  async execute(input, ctx) {
    const raw = ctx.messageCache.getConversationContext({
      messageId: input.message_id as string,
      window: input.window as number | undefined,
    });
    if ("error" in raw) return { content: raw.error };
    collectKnownUsersFromRows(raw, ctx.knownUsers);
    return { content: formatMessageRows(raw, describeQuery("get_conversation_context", input)) };
  },
};

export const getRecentActivityEntry: ToolEntry<"messageCache"> = {
  name: "get_recent_activity",
  definition: {
    name: "get_recent_activity",
    description: "Get the most recent messages from a specific user across all cached channels.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID (snowflake)" },
        days: { type: "number", description: "Look back this many days (default: 7)" },
        limit: { type: "number", description: "Maximum number of messages to return (default: 15, max: 200)." },
      },
      required: ["user_id"],
    },
  },
  requiresHosts: ["messageCache"],
  async execute(input, ctx) {
    const raw = ctx.messageCache.getRecentActivity({
      userId: input.user_id as string,
      days: input.days as number | undefined,
      limit: input.limit as number | undefined,
    });
    collectKnownUsersFromRows(raw, ctx.knownUsers);
    return { content: formatMessageRows(raw, describeQuery("get_recent_activity", input)) };
  },
};

export const resolveUsersByNameEntry: ToolEntry<"messageCache"> = {
  name: "resolve_users_by_name",
  definition: {
    name: "resolve_users_by_name",
    description: "Look up Discord user IDs by username or display name, ordered by most recently active.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Partial or full username or display name (case-insensitive substring match)." },
        days: { type: "number", description: "Only consider users active in the last N days (default: 30)." },
        limit: { type: "number", description: "Maximum number of candidates to return (default: 10, max: 25)." },
      },
      required: ["name"],
    },
  },
  requiresHosts: ["messageCache"],
  async execute(input, ctx) {
    const rows = ctx.messageCache.resolveUsersByName({
      name: input.name as string,
      days: input.days as number | undefined,
      limit: input.limit as number | undefined,
    });
    if (rows.length === 0) return { content: "(no results)" };
    const lines = rows.map((u) => {
      const seconds = Math.floor(u.last_active / 1000);
      const name = u.author_display_name && u.author_display_name !== u.author_username ? `${u.author_username} / ${u.author_display_name}` : (u.author_username ?? "unknown");
      return `u:${u.author_id} ${name} — last active t:${seconds}:R, ${u.message_count} messages`;
    });
    return { content: lines.join("\n") };
  },
};

export const getUserProfileEntry: ToolEntry<"messageCache"> = {
  name: "get_user_profile",
  definition: {
    name: "get_user_profile",
    description: "Get a user's activity summary in this server — first seen date, total messages, channel distribution, and daily message frequency over the last 30 days.",
    parameters: {
      type: "object",
      properties: { user_id: { type: "string", description: "Discord user ID (snowflake)" } },
      required: ["user_id"],
    },
  },
  requiresHosts: ["messageCache"],
  async execute(input, ctx) {
    const userId = input.user_id as string;
    const r = ctx.messageCache.getUserProfile(userId);
    const header = `Profile for u:${userId}:`;
    if (!r.summary || r.summary.total_messages === 0) return { content: `${header}\n(no messages found for this user in the cache)` };

    const lines: string[] = [header];
    if (r.summary.first_seen) lines.push(`first seen: t:${Math.floor(r.summary.first_seen / 1000)}:R`);
    if (r.summary.last_seen) lines.push(`last seen: t:${Math.floor(r.summary.last_seen / 1000)}:R`);
    lines.push(`total messages: ${r.summary.total_messages} across ${r.summary.channel_count} channels`);
    if (r.channelDistribution.length > 0) {
      lines.push("top channels:");
      for (const ch of r.channelDistribution) lines.push(`  c:${ch.channel_id}: ${ch.count} messages`);
    }
    if (r.dailyActivity.length > 0) {
      lines.push("daily activity (recent 30 days):");
      for (const d of r.dailyActivity) lines.push(`  ${d.day}: ${d.count}`);
    }
    return { content: lines.join("\n") };
  },
};

export const MESSAGE_CACHE_TOOL_ENTRIES: ToolEntry<"messageCache">[] = [
  searchMessagesEntry,
  getConversationContextEntry,
  getRecentActivityEntry,
  resolveUsersByNameEntry,
  getUserProfileEntry,
];
