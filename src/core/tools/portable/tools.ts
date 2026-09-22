// Tools that need no host: memory + update_server_context work purely off ctx.memory
// (SpaceMemoryStore, contracts.ts §8), web_search/fetch_url_content hit Exa directly (no
// discord.js), and ask_question only needs ctx.pending + ctx.owner.
import type { ToolEntry } from "../../contracts.ts";
import "../pendingSink.ts";
import { webSearch, fetchUrlContent } from "../../../tools/webSearch.ts";

const MAX_SERVER_CONTEXT_CHARS = 4000;

export const memoryEntry: ToolEntry = {
  name: "memory",
  definition: {
    name: "memory",
    description:
      "Manage persistent agent memory across conversations. Use write for any durable fact worth recalling later. Do NOT write live/mutable facts already tracked elsewhere (roles, automod config, ban/timeout status). Use read with an exact title for one entry, read with a query for keyword search, read with neither to list everything, write to save/update, delete to remove.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "delete"], description: "Operation to perform." },
        title: { type: "string", description: "Memory title (unique key). Required for write and delete." },
        query: { type: "string", description: "For read: keyword search over titles and content." },
        content: { type: "string", description: "Memory content. Required for write." },
      },
      required: ["action"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const action = input.action as string;
    const spaceId = ctx.space.spaceId;

    if (action === "write") {
      const title = input.title as string | undefined;
      const content = input.content as string | undefined;
      if (!title || !content) return { content: "write requires both title and content" };
      const result = ctx.memory.upsert(spaceId, title, content);
      return { content: "error" in result ? result.error : "ok" };
    }

    if (action === "delete") {
      const title = input.title as string | undefined;
      if (!title) return { content: "delete requires title" };
      const deleted = ctx.memory.delete(spaceId, title);
      return { content: deleted ? "ok" : `No memory found with title "${title}"` };
    }

    // read
    const title = input.title as string | undefined;
    const query = input.query as string | undefined;
    if (title) {
      const row = ctx.memory.read(spaceId, title);
      if (!row) return { content: `No memory found with title "${title}"` };
      return { content: `**${row.title}** (updated t:${Math.floor(row.updatedAt / 1000)}:R)\n${row.content}` };
    }
    if (query) {
      const rows = ctx.memory.search(spaceId, query);
      if (rows.length === 0) return { content: `No memories matched "${query}"` };
      return { content: rows.map((m) => `**${m.title}** (updated t:${Math.floor(m.updatedAt / 1000)}:R)\n${m.content}`).join("\n\n---\n\n") };
    }
    const titles = ctx.memory.listTitles(spaceId);
    if (titles.length === 0) return { content: "(no memories)" };
    const rows = titles.map((t) => ctx.memory.read(spaceId, t)).filter((r) => r !== null);
    return { content: rows.map((m) => `**${m.title}** (updated t:${Math.floor(m.updatedAt / 1000)}:R)\n${m.content}`).join("\n\n---\n\n") };
  },
};

export const updateServerContextEntry: ToolEntry = {
  name: "update_server_context",
  definition: {
    name: "update_server_context",
    description:
      "Overwrite the server context — the persistent, always-injected knowledge base about this server. Call this after a server scan or when the context needs updating. This fully replaces the existing content.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Full markdown content for the server context. For rules, store only a pointer (e.g. \"c:CHANNEL_ID\") — never the rule text itself.",
        },
      },
      required: ["content"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const content = input.content as string;
    if (content.length > MAX_SERVER_CONTEXT_CHARS) {
      return { content: `Server context too long (${content.length} chars, max ${MAX_SERVER_CONTEXT_CHARS}). Condense the content and try again.` };
    }
    ctx.memory.setServerContext(ctx.space.spaceId, content);
    return { content: "ok" };
  },
};

export const webSearchEntry: ToolEntry = {
  name: "web_search",
  definition: {
    name: "web_search",
    description: "Search the public web for current information not in the message cache or your training data.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        num_results: { type: "number", description: "Number of results to return (default: 5, max: 10)." },
        search_type: { type: "string", enum: ["auto", "instant", "fast"], description: "Search speed/depth tradeoff." },
      },
      required: ["query"],
    },
  },
  requiresHosts: [],
  async execute(input) {
    const raw = await webSearch({
      query: input.query as string,
      num_results: input.num_results as number | undefined,
      search_type: input.search_type as Parameters<typeof webSearch>[0]["search_type"],
    });
    if ("error" in raw) return { content: raw.error };
    if (raw.length === 0) return { content: "(no results)" };
    return {
      content: raw
        .map((r) => {
          const lines: string[] = [`${r.title ?? "(untitled)"} — ${r.url}`];
          if (r.publishedDate) lines.push(`  published: ${r.publishedDate}`);
          for (const h of r.highlights) lines.push(`  "${h}"`);
          return lines.join("\n");
        })
        .join("\n\n"),
    };
  },
};

export const fetchUrlContentEntry: ToolEntry = {
  name: "fetch_url_content",
  definition: {
    name: "fetch_url_content",
    description: "Fetch the clean parsed text content of a specific, known URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The exact URL to fetch content for." } },
      required: ["url"],
    },
  },
  requiresHosts: [],
  async execute(input) {
    const raw = await fetchUrlContent({ url: input.url as string });
    if ("error" in raw) return { content: raw.error };
    const lines: string[] = [`${raw.title ?? "(untitled)"} — ${raw.url}`];
    if (raw.publishedDate) lines.push(`published: ${raw.publishedDate}`);
    lines.push("", raw.text || "(no text content)");
    if (raw.truncated) lines.push("", "[content truncated — page may contain more]");
    return { content: lines.join("\n") };
  },
};

export const askQuestionEntry: ToolEntry = {
  name: "ask_question",
  definition: {
    name: "ask_question",
    description:
      "Ask the moderator a clarifying question with button choices. Use this when you genuinely need their input before you can proceed. The conversation pauses until they click a button. Must be called alone.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask. One sentence, no filler." },
        choices: { type: "array", items: { type: "string" }, description: "Button labels (2–5 options).", minItems: 2, maxItems: 5 },
      },
      required: ["question", "choices"],
    },
  },
  requiresHosts: [],
  requiresCapabilities: ["interactiveChoices"],
  async execute(input, ctx) {
    if (!ctx.owner) return { content: "Cannot ask a question right now — the original requester's identity was lost mid-conversation." };
    if (!ctx.pending) return { content: "ask_question is unavailable in this context." };
    ctx.pending.push({
      kind: "question",
      payload: { question: input.question as string, choices: input.choices as string[], authorizedResponder: ctx.owner },
    });
    return { content: "Question sent to moderator. Awaiting their response via button click." };
  },
};

export const resetConversationEntry: ToolEntry = {
  name: "reset_conversation",
  definition: {
    name: "reset_conversation",
    description:
      "Start a fresh conversation, clearing the remembered message history of THIS conversation only. Durable agent memory is NOT affected. Use only when the user explicitly asks to start over, start fresh, clear the chat, or begin a new conversation.",
    parameters: { type: "object", properties: {} },
  },
  requiresHosts: [],
  async execute(_input, ctx) {
    ctx.reset?.request();
    return { content: "Conversation history cleared — starting fresh. Durable memory is unaffected." };
  },
};

export const PORTABLE_TOOL_ENTRIES: ToolEntry[] = [memoryEntry, updateServerContextEntry, webSearchEntry, fetchUrlContentEntry, askQuestionEntry, resetConversationEntry];
