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
            description: "Maximum number of messages to return (default: 15, max: 200). Start small — call again with a higher limit if more history is needed.",
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
        "Fetch messages directly from the Discord API by ID or ID range — use this when a message is not in the local cache (e.g. older than 30 days, or a mod linked a specific message). Use message_id alone when you only need that specific message. Use around only when you genuinely need surrounding context to understand an incident, and keep the limit small (5–10). Start narrow and expand if needed.",
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
            description: "Number of messages to return for range fetches (1–100, default 10). Start small and fetch more only if needed. Ignored when message_id is set.",
          },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_image",
      description:
        "Fetch and inspect all images attached to a specific message. Call this proactively whenever a mod asks to check, review, or investigate a message that turns out to contain only images ([image: filename.ext]) — don't ask for confirmation first. Also call it when an image is central to the incident being investigated.",
      parameters: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Discord channel ID — the first number in a msg:channelId/messageId reference.",
          },
          message_id: {
            type: "string",
            description: "Discord message ID — the second number in a msg:channelId/messageId reference.",
          },
        },
        required: ["channel_id", "message_id"],
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
  {
    type: "function",
    function: {
      name: "ask_question",
      description:
        "Ask the moderator a clarifying question with button choices. Use this when you genuinely need their input before you can proceed — not as a courtesy check. The conversation pauses until they click a button. Keep the question short and direct. Choices should be mutually exclusive and cover the likely answers.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the moderator. One sentence, no filler.",
          },
          choices: {
            type: "array",
            items: { type: "string" },
            description: "Button labels for the moderator to choose from (2–5 options, short labels).",
            minItems: 2,
            maxItems: 5,
          },
        },
        required: ["question", "choices"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_guild_roles",
      description:
        "List all roles in the server with their permissions, sorted by hierarchy. Use during server scan or when you need to understand the role structure — who the moderators are, what roles have what permissions.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_server_context",
      description:
        "Overwrite the server context — the persistent, always-injected knowledge base about this server (channels, roles, mod team, culture, bot setup). Call this after a server scan or when the context needs updating. Write in clear markdown sections. This fully replaces the existing content.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Full markdown content for the server context. Use sections like ## Channels, ## Roles, ## Mod Team, ## Notes.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description:
        "Read one or all agent memory entries. Call with a title to fetch a specific memory's full content. Call without a title to fetch all memories. Use when the memory index in the system prompt shows entries relevant to the current query.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the specific memory to read. Omit to read all memories.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_memory",
      description:
        "Save or update an agent memory entry. Use this to remember things that would help future conversations: recurring patterns, important context, corrections, anything a mod would otherwise have to re-explain. Update existing entries (same title) rather than creating near-duplicates. Keep content concise.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short, descriptive title for this memory (used as the unique key). Be specific enough to identify it in the index.",
          },
          content: {
            type: "string",
            description: "The memory content. Keep it focused and concise — this is recalled across conversations, not stored for this session only.",
          },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description:
        "Delete an agent memory entry by title. Use when a memory is stale, resolved, or no longer relevant. Also use to make room when the memory limit is reached.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Exact title of the memory to delete.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_guild_channels",
      description:
        "List all channels in the server, organized by category. Use this to understand the server's channel structure — which channels are private (mod-only), which are public, and how they're organized. Useful when you need to understand what channel a user was posting in, or to check if a channel is a staff channel.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_channel_info",
      description:
        "Get details about a specific channel — its name, type, whether it's private/mod-only, its category, and topic. Use this when you see a channel ID in tool results and need to understand what that channel is.",
      parameters: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Discord channel ID (snowflake)",
          },
        },
        required: ["channel_id"],
      },
    },
  },
];
