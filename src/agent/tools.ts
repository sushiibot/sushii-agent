import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_messages",
      description:
        "Search or browse the server's cached message history (last 30 days). Provide a query for full-text search ranked by relevance; omit it to browse recent messages by time. Supports optional filters for users, channel, and time range. Bot messages are excluded by default — set include_bots=true when searching modmail threads, log channels, or other bot-forwarded content.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Optional FTS5 search query. Supports AND, OR, NOT, phrase quotes, and prefix wildcards (e.g., "hate*" matches "hater", "hateful"). A bare * is not valid. Omit to browse without filtering by content.',
          },
          user_ids: {
            type: "array",
            items: { type: "string" },
            description: "Filter to messages from these Discord user IDs. Supports multiple users (e.g. two people in a conflict).",
          },
          channel_id: {
            type: "string",
            description: "Filter results to a specific channel ID",
          },
          since: {
            type: "number",
            description: "Return only messages after this Unix timestamp in milliseconds",
          },
          until: {
            type: "number",
            description: "Return only messages before this Unix timestamp in milliseconds",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 20, max: 100)",
          },
          is_automod: {
            type: "boolean",
            description: "If true, return only AutoMod alert messages (flagged/blocked content). If false, exclude them. Omit to return all messages.",
          },
          include_bots: {
            type: "boolean",
            description: "If true, include messages from bots (e.g. modmail relay, log bots). Defaults to false to reduce noise from fun/utility bots.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_conversation_context",
      description:
        "Get surrounding context for a specific message — messages before and after it in the same channel, plus any reply chain references.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "Discord message ID (snowflake) of the anchor message",
          },
          window: {
            type: "number",
            description:
              "Number of messages to retrieve before and after the anchor (default: 10)",
          },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_profile",
      description:
        "Get a user's activity summary in this server — first seen date, total messages, channel distribution, and daily message frequency over the last 30 days.",
      parameters: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID (snowflake)",
          },
        },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_activity",
      description:
        "Get the most recent messages from a specific user across all cached channels, useful for assessing recent behavior and tone.",
      parameters: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID (snowflake)",
          },
          days: {
            type: "number",
            description: "Look back this many days (default: 7)",
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return (default: 50, max: 200)",
          },
        },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_audit_log",
      description:
        "Search the server's audit log for moderation actions. Always provide at least one filter (action_type, executor_id, or target_id) — unfiltered results are dominated by nickname changes and other noise.",
      parameters: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            enum: ["ban", "unban", "kick", "member_update", "role_update", "message_delete", "message_bulk_delete", "automod_block"],
            description:
              "Filter by action type. Use 'member_update' for timeouts and nickname changes, 'role_update' for role assignments/removals.",
          },
          executor_id: {
            type: "string",
            description: "Filter to actions performed by this Discord user ID (the moderator).",
          },
          target_id: {
            type: "string",
            description: "Filter to actions targeting this Discord user ID (the user who was moderated).",
          },
          limit: {
            type: "number",
            description: "Maximum number of entries to return (default: 25, max: 100).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_users_by_name",
      description:
        "Look up Discord user IDs by username or display name. Use this whenever a moderator refers to someone by name/handle instead of a Discord mention or user ID. Returns recently active users whose username or display name matches, ordered by most recently active. If multiple candidates are returned, surface them to the moderator for clarification.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Partial or full username or display name to search for (case-insensitive substring match).",
          },
          days: {
            type: "number",
            description: "Only consider users active in the last N days (default: 30).",
          },
          limit: {
            type: "number",
            description: "Maximum number of candidates to return (default: 10, max: 25).",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_channel_messages",
      description:
        "Fetch messages directly from the Discord API by ID or ID range — use this when a message is not in the local cache (e.g. older than 30 days, or a mod linked a specific message). For a single message provide message_id. To get a message AND its surrounding context (recommended when investigating a linked message), use around instead — it returns the message plus messages before and after in one call.",
      parameters: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Discord channel ID (snowflake). Extractable from a message link: discord.com/channels/{guild}/{channel}/{message}.",
          },
          message_id: {
            type: "string",
            description: "Fetch exactly this one message by ID. Mutually exclusive with before/after/around.",
          },
          before: {
            type: "string",
            description: "Fetch messages sent before this message ID (exclusive). Mutually exclusive with after and around.",
          },
          after: {
            type: "string",
            description: "Fetch messages sent after this message ID (exclusive). Mutually exclusive with before and around.",
          },
          around: {
            type: "string",
            description: "Fetch messages around this message ID. Mutually exclusive with before and after.",
          },
          limit: {
            type: "number",
            description: "Number of messages to return for range fetches (1–100, default 50). Ignored when message_id is set.",
          },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_member_info",
      description:
        "Get live Discord information about a member — current roles, join date, and whether they are still in the server. Makes a live Discord API call.",
      parameters: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID (snowflake)",
          },
        },
        required: ["user_id"],
      },
    },
  },
];
