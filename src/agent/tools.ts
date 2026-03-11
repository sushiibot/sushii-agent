import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_messages",
      description:
        "Full-text search through the server's cached message history (last 30 days). Returns messages matching the query, optionally filtered by user, channel, or time range.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'FTS5 search query. Supports operators: AND, OR, NOT, and phrase quotes (e.g., "exact phrase"). Example: "harassment OR slur"',
          },
          user_id: {
            type: "string",
            description: "Filter results to messages from a specific Discord user ID",
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
        },
        required: ["query"],
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
