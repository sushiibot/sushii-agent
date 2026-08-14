import type { ChatCompletionTool } from "openai/resources/chat/completions";

// MCP tool definitions are fetched from the sushii-mcp server at startup via
// SushiiMcpClient.getTools() and pushed into TOOL_DEFINITIONS in bot.ts startBot().

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_messages",
      description:
        "Search or browse the server's cached message history (last ~30 days). Provide a query for full-text search ranked by relevance; omit it to browse recent messages by time. Supports optional filters for users, channel, and time range. Bot messages are excluded by default — set include_bots=true when searching modmail threads, log channels, or other bot-forwarded content. For messages older than the cache, use search_guild_messages instead.\n\nSearch tips: use ONE rare, distinctive keyword rather than a phrase — multi-word queries require ALL words to appear in the same message. Bare terms match exactly (e.g. 'warn' matches only 'warn') — use 'warn*' to also match 'warned', 'warning'. Use OR for alternatives (e.g. 'shelf OR shelves'), NEAR(word1 word2, 10) for proximity, or quotes for exact phrases.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Optional FTS5 search query. Prefer a single distinctive keyword (e.g. "shelf" not "shelf banned member") — multi-word queries require ALL words present in the same message. Bare terms are exact-matched; append * for prefix matching (e.g. "warn*" matches "warned", "warning"). Supports OR, NOT, NEAR(), and phrase quotes. Omit to browse without filtering by content.',
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
      name: "search_guild_messages",
      description:
        "Search all guild message history via the Discord API — use this when the local cache (last ~30 days) doesn't have what you need, e.g. for older incidents or long-term behaviour patterns. Slower than search_messages and limited to 25 results per call; use offset to paginate. At least one of content, author_id, or channel_id is required.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Filter by message content (substring match, max 1024 chars).",
          },
          author_id: {
            type: "string",
            description: "Filter to messages from this Discord user ID.",
          },
          channel_id: {
            type: "string",
            description: "Filter to messages in this channel ID.",
          },
          has: {
            type: "string",
            enum: ["image", "video", "file", "embed", "link", "poll"],
            description: "Filter to messages that contain this type of attachment or embed.",
          },
          limit: {
            type: "number",
            description: "Results per page (1–25, default 25).",
          },
          offset: {
            type: "number",
            description: "Pagination offset (0–9975). Use to page through results beyond the first 25.",
          },
          sort_by: {
            type: "string",
            enum: ["timestamp", "relevance"],
            description: "Sort by timestamp (default) or relevance when content is provided.",
          },
          sort_order: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort direction (default: desc — newest first).",
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
        "Queue one or more images so they appear in your next message for visual analysis. Call this proactively whenever a mod asks to check, review, or investigate a message that turns out to contain only images ([image: filename.ext](url)) — don't ask for confirmation first. Also call it when an image is central to the incident being investigated, e.g. a member's avatar (avatarUrl from get_current_member_info) that other members reacted to with shock or called out as inappropriate.\n\nDiscord's attachment/media URLs are signed and expire after a while, so a URL copied from older fetched content (search_messages, get_conversation_context, get_recent_activity, or anything not just fetched this turn) may already be dead. For those, pass channel_id + message_id via `messages` instead — this re-fetches the message live and always gets working URLs. Only use `image_urls` directly for URLs with no backing message (e.g. avatarUrl) or images you just fetched this same turn.",
      parameters: {
        type: "object",
        properties: {
          image_urls: {
            type: "array",
            items: { type: "string" },
            description: "Direct URLs of images to inspect that have no backing Discord message, e.g. an avatarUrl returned by get_current_member_info. Must be Discord CDN URLs (cdn.discordapp.com or media.discordapp.net) — arbitrary external URLs are rejected.",
          },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                channel_id: { type: "string", description: "Discord channel ID — the first number in a msg:channelId/messageId reference." },
                message_id: { type: "string", description: "Discord message ID — the second number in a msg:channelId/messageId reference." },
              },
              required: ["channel_id", "message_id"],
            },
            description: "Messages to re-fetch live and inspect all image attachments/components from. Use this for any message whose content you fetched earlier (not this turn) to avoid expired URLs.",
          },
        },
        anyOf: [{ required: ["image_urls"] }, { required: ["messages"] }],
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
            description: "Full markdown content for the server context. Use sections like ## Channels, ## Roles, ## Mod Team, ## Notes, ## Rules Channel. For rules, store only a pointer (e.g. \"c:CHANNEL_ID\") — never the rule text itself, since it can change without this context being refreshed. Always fetch the live channel content via fetch_channel_messages when the actual rule text is needed.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory",
      description:
        "Manage persistent agent memory across conversations. Use write for ANY durable fact worth recalling later: a stated preference, a correction someone gave you, a recurring question, established server norms/culture, or context from past incidents. Do NOT write live/mutable facts that are already tracked elsewhere and could go stale — moderator roster, role permissions, automod config, ban/timeout status; always re-fetch those live instead. Use read with an exact title (from the memory index) to fetch one entry, read with a query for a ranked keyword search over titles and content when you don't know the exact title, read with neither to list everything, write to save/update, delete to remove stale entries. Prefer updating existing entries over creating near-duplicates.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "write", "delete"],
            description: "Operation to perform.",
          },
          title: {
            type: "string",
            description: "Memory title (unique key). Required for write and delete; for read, use when you know the exact title from the memory index.",
          },
          query: {
            type: "string",
            description: "For read: keyword search over memory titles and content, ranked by relevance. Use when you don't know the exact title. Ignored if title is set.",
          },
          content: {
            type: "string",
            description: "Memory content. Required for write. Keep concise — this persists across conversations.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_guild_info",
      description:
        "Get server-level information — name, member count, owner, creation date, verification level, boost tier, and enabled features. Use this to understand the scale and configuration of the server.",
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
      name: "list_automod_rules",
      description:
        "List all auto-moderation rules for this server — names, IDs, trigger types, keyword/regex counts, enabled status, and actions. Use this to understand what is currently filtered before suggesting additions or investigating what automod would or wouldn't catch. Shows full keyword lists for KEYWORD and MEMBER_PROFILE rules.",
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
      name: "add_automod_keyword",
      description:
        "Add a single keyword to an existing automod rule's keyword_filter. This triggers an approval gate — do NOT call ask_question before this tool, the moderator will be prompted automatically with a confirmation showing the exact change. Only works for KEYWORD and MEMBER_PROFILE trigger type rules.\n\nWildcard syntax: *word* = match anywhere, word* = prefix, *word = suffix, word = whole-word only. Max 60 chars per keyword. Case-insensitive at match time.",
      parameters: {
        type: "object",
        properties: {
          rule_id: {
            type: "string",
            description: "The automod rule ID (snowflake) to add the keyword to. Get this from list_automod_rules.",
          },
          keyword: {
            type: "string",
            description: "The keyword string to add. Use wildcard * where appropriate. Max 60 characters.",
          },
        },
        required: ["rule_id", "keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_automod_keyword",
      description:
        "Remove a single keyword from an existing automod rule's keyword_filter. This triggers an approval gate — do NOT call ask_question before this tool, the moderator will be prompted automatically with a confirmation showing the exact change. Returns an error immediately if the keyword is not found in the rule. Use list_automod_rules to find the exact keyword string and rule ID first.",
      parameters: {
        type: "object",
        properties: {
          rule_id: {
            type: "string",
            description: "The automod rule ID (snowflake) to remove the keyword from. Get this from list_automod_rules.",
          },
          keyword: {
            type: "string",
            description: "The keyword string to remove. Must match an existing entry (case-insensitive). Get the exact string from list_automod_rules.",
          },
        },
        required: ["rule_id", "keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for current information not in the message cache or your training data — e.g. known scam/phishing patterns, breaking news, verifying a claim, or looking up a linked website. Returns titles, URLs, and query-relevant excerpts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          num_results: {
            type: "number",
            description: "Number of results to return (default: 5, max: 10).",
          },
          search_type: {
            type: "string",
            enum: ["auto", "instant", "fast"],
            description: "Search speed/depth tradeoff. 'auto' (default) balances relevance and speed. 'instant' is fastest for quick lookups. 'fast' trades a bit of speed for better relevance.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url_content",
      description:
        "Fetch the clean parsed text content of a specific, known URL — e.g. a link a moderator pasted or a link found in a message. Use this instead of web_search when you already have the exact URL and need to know what's on the page.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The exact URL to fetch content for.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_channel_info",
      description:
        "Get channel information. Without channel_id: lists all channels in the server organized by category — use this to understand the server structure, which channels are private (mod-only), etc. With channel_id: get details about that specific channel — name, type, privacy, category, and topic.",
      parameters: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Discord channel ID (snowflake). Omit to list all channels.",
          },
        },
        required: [],
      },
    },
  },
  // Auto-mod action tools — only available when autoModTrigger is set (gated in buildAiTools)
  {
    type: "function",
    function: {
      name: "timeout_member",
      description:
        "Apply a timeout (communication disable) to a member. Only available in auto-mod mode. Do NOT call this for members with mod-immune roles — the tool returns an error in that case. Default duration: 3600000 ms (1 hour). Maximum: 2419200000 ms (28 days). Duration is clamped automatically.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "Discord user ID of the member to timeout." },
          duration_ms: { type: "number", description: "Timeout duration in milliseconds (default: 3600000 = 1 hour, max: 2419200000 = 28 days)." },
          reason: { type: "string", description: "Category label for the timeout, 1-2 words, shown to the user being timed out. Use a plain category only: \"Harassment\", \"Hate speech\", \"Spam\", \"Trolling\", \"NSFW content\", \"Threats\", \"Doxxing\", \"Raiding\". Never include quoted messages, usernames, evidence, your reasoning, or suspicion — that belongs in send_alert_message. Never reveal that the action was automated or taken by a bot. Omit this entirely if no short category fits." },
        },
        required: ["user_id", "duration_ms"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_user_messages",
      description:
        "Delete recent messages from a specific user in a specific channel. Only available in auto-mod mode. Scoped to the incident channel only — do NOT pass a different channel_id. Bulk-deletes messages ≤14 days old; falls back to sequential deletion for older messages. Returns counts for bulk-deleted, sequential-deleted, and errors.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "Discord user ID whose messages to delete." },
          channel_id: { type: "string", description: "The incident channel ID. Must match the channel where the mod-ping occurred." },
          limit: { type: "number", description: "Maximum number of messages to delete (default: 50, max: 100)." },
        },
        required: ["user_id", "channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_alert_message",
      description:
        "Post a summary to the configured mod alerts channel with a mod-role ping. Call this at the end of every auto-mod run — whether action was taken or not. This is a skim-read for a mod on their phone, not a report. Never write either field as a flowing paragraph — that includes sentences joined with 'and'/'because' to smuggle multiple facts onto one line. Each fact gets its own short line.",
      parameters: {
        type: "object",
        properties: {
          findings: {
            type: "string",
            description:
              "A bullet list, max 4-5 bullets total — this is a skim-read, not a case file. One short clause per bullet. Do NOT give each message/reaction its own bullet; group the repeated pattern into one bullet (e.g. '- Posted 5 inflammatory messages baiting the group, incl. msg:...' not five separate bullets, one per message). Cover only: who did it, join date (if relevant to the case), prior history (only if there is any — omit the bullet entirely if none), and the pattern observed. Include at most one or two msg: citations total, on whichever bullet needs evidence — not one per fact. Example:\n- New member, joined t:...\n- Posted 5 messages baiting the group with false accusations, incl. msg:...\n- No prior history in this server",
          },
          action: {
            type: "string",
            description:
              "Labeled lines, each its own line, each one short clause — never combine two labels' worth of info into one sentence:\n**Action:** <what was done, or \"none — flagged for manual review\">\n**Why:** <the one-clause trigger/evidence that justified it>\n**Background:** <one clause of relevant context, if any — account age, history, prior warnings>\n**Recommendation:** <only if follow-up is needed — e.g. \"ban — posted CSAM, timeout is a stopgap\", \"kick — ...\", or \"manual pfp review\". Always include this when the offense would justify a ban or kick, since you can only timeout.>\nOmit a label entirely if there's nothing to say for it rather than padding it. Anti-example (too dense, do NOT do this): '**Why:** brand-new member who joined July 24 2026 12:21 PM and immediately started baiting with false accusations against the group, unambiguously trolling in a dedicated fan server.' Instead: '**Why:** New member, baited group with false accusations within minutes of joining.'",
          },
        },
        required: ["findings", "action"],
      },
    },
  },
];

