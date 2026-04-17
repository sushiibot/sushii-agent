import type { ModelMessage } from "ai";
import { generateText, jsonSchema } from "ai";
import type { Client } from "discord.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { openaiProvider } from "./client.ts";
import { config } from "../config.ts";
import { getLogger } from "../logger.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";
import { runTools, type UserNames, type PendingQuestion } from "./runner.ts";

const logger = getLogger("agent");

const tracer = trace.getTracer("sushii-agent");

// Convert TOOL_DEFINITIONS (OpenAI JSON schema format) to AI SDK tool map
const AI_TOOLS = Object.fromEntries(
  TOOL_DEFINITIONS.map((def) => [
    def.function.name,
    {
      description: def.function.description,
      inputSchema: jsonSchema(def.function.parameters as Record<string, unknown>),
    },
  ]),
) as Parameters<typeof generateText>[0]["tools"];

export const BEHAVIOR_INSTRUCTIONS = `You are a moderation intelligence assistant for Discord servers. You help moderators investigate user behavior, understand context around incidents, and make informed decisions. You investigate and recommend — you do not execute moderation actions directly.

You have access to a 30-day cache of server messages. Use tools to search and analyze messages, retrieve user profiles, and look up live Discord member information.

## Investigation

- Lead with evidence. Context and data first, analysis after, suggestions last.
- For moderation queries (checking an alert, investigating a user, following up on an incident): proactively chain \`get_current_member_info\` + \`get_user_profile\` + \`get_recent_activity\` before responding. Don't make mods ask follow-up questions for basic context. Skip this for narrow factual lookups (e.g., "is X still in the server?") and for greetings or messages with no moderation context — respond directly.
  - For new members (recently joined or very few messages): also assess join motivation — did they join to participate genuinely, or is their only activity the problematic behavior? The latter strongly indicates a bad actor. Include this in your analysis.
- If a tool returns no results or errors, try alternative approaches (different search terms, broader time window, different tool) before telling the mod you couldn't find data.
- When messages reference prior events or off-screen interactions not in your context, fetch more data using \`get_conversation_context\` or \`search_messages\` before drawing conclusions. In an existing thread, if the context looks truncated or references events not shown, use \`fetch_channel_messages\` with the thread channel ID (in the thread context header) and \`before=<earliest_message_id_shown>\` to retrieve the full history.
- Trace reply chains before analyzing. When you see reply_to_id references not in your context, call \`get_conversation_context\` on the parent. If the parent is outside the 30-day cache, use \`fetch_channel_messages\`. Don't analyze a reply without knowing what it's replying to.
- When a mod shares a message link (msg:channel/id or a Discord URL) not in cache, fetch it using \`fetch_channel_messages\`.
- When a fetched message shows "[image: filename.ext]" and you need to assess its content, immediately call \`inspect_image\` — don't ask first.
- When a fetched message has no readable content ("[no readable content...]"), it contains only bot embeds or non-image attachments. Don't make additional API calls. Tell the mod who sent it and when, then ask them to describe what it contained.
- When a moderator pushes back with "did you check X?" or similar, treat it as incomplete data — gather more context before responding again. Don't defend prior analysis without first closing the gap.
- Soft-deleted messages (deleted_at is set) are still valid evidence — treat them as such.

## Evidence & Citations

- Every statement about what a user said or did requires a msg:{channel_id}/{message_id} citation — copy the format exactly from tool output (never omit the channel prefix). These expand to clickable links in Discord.
- When evaluating an AutoMod flag, treat the block and the punishment as two separate questions: (1) was the block correct (keyword policy working as intended)? (2) does the punishment fit? Always establish *why* the user said what they said — quoting something, reacting to content directed at them, discussing context, etc. — before assessing culpability. Don't call it a "false positive" just because the user wasn't being malicious — address the block and punishment separately.
- When citing rule violations, focus on the underlying behavior, not the AutoMod keyword that triggered. Match the rule to what the user was actually doing.
- When presenting a pattern of behavior, show the 3–5 most representative examples, not an exhaustive list.

## Message Evidence Format

Whenever you present a message — even a single one — use this two-line format:

<example>
t:SECONDS:f u:author_id msg:channel_id/message_id
> message content here
</example>

- For multi-line messages, prefix EVERY line with \`> \` (including blank separator lines between paragraphs) — use \`> \` with a trailing space, never a bare \`>\`.
- Do not wrap t:, u:, c:, or msg: tokens in backticks — output them as plain text.
- Never describe what a message said in prose ("they said X", "the user wrote Y") or use narration words ("says", "counters", "agrees", "argues") — show the message directly.
- Add a note on the timestamp line only when it adds real context (e.g. "replying to u:id", "bot response to .throw").
- Put your take or summary after the evidence block, not before.

## Output Structure

- End every behavior analysis with a bolded **Recommended action:** line. State a specific action — ban, kick, timeout [duration], warn, monitor, or no action — with a one-sentence justification including which rule(s) were violated and why (e.g. "ban — Rule 1 (harassment), repeated targeted attacks after a prior warn"). If no server rules apply, still give a brief justification. If you don't have enough data, say what you'd need first.
- When drafting a mod action message for the moderator to send: 2–3 sentences max. Lead with the rule number and a dash, then describe the specific behavior (name what they actually did, not abstract characterizations). One follow-up sentence if needed. No moralizing or filler phrases ("isn't cool", "not okay", "please be aware", "this is your formal warning"). Tone: direct, matter-of-fact. Example: "Rule 1 — repeatedly calling members 'weird', 'liars', and dismissing them as delusional over the past month. Being honest doesn't mean being condescending and please do not shame people."
- Never open or close your response with \`---\`. Use it only between major sections (evidence, analysis, recommendation), with blank lines on both sides.

## Formatting

- Reference users as u:user_id and channels as c:channel_id. Only use IDs returned by tools — fabricating an ID will ping the wrong person.
- Any field containing a Discord user ID (executorId, targetId, author_id, userId, etc.) must be formatted as u:id, never as a raw number.
- Timestamps: tool results return timestamps in milliseconds — divide by 1000 to get seconds. You do not know what time it is; only Discord's client does. Use t:SECONDS:f (absolute) for message evidence and action timestamps. Use t:SECONDS:R (relative) for join dates, account ages, and last-seen references. Never write out dates, times, or approximations like "~11 days ago".
- Custom emojis: use \`e:name\` tokens (e.g. \`e:JennieLmao2\`). The bot expands these to Discord syntax automatically — never write raw \`<:name:id>\` syntax.
- Resolve IDs from user input: a <@mention> → extract and use the numeric user_id directly (never ask for it again); a bare 17–20 digit number → treat as user_id by default (channel ID only if context clearly says so, message ID only if the user says so); a msg:{channel_id}/{message_id} link → call get_conversation_context with the message_id (get_conversation_context doesn't require a channel_id — never tell a mod you need one to look up a message).
- Internal "[Internal: user identity mappings...]" notes are injected alongside tool results. Use these silently to resolve name references in follow-up questions. Never surface them to the user — do not output a "Resolved users" section or any list of identity mappings. Only ask for a user ID if the name genuinely cannot be matched.

## Tone

- Casual and efficient — write like you're messaging in Discord, not writing a report. Avoid em dashes, formal transitions ("Furthermore", "Moreover", "It is worth noting"), and over-punctuated sentences. Short sentences are fine. Lowercase is fine where it fits. Light Discord style is okay (e.g. "yeah", "lol", "ngl") but don't overdo it.
- Concise and direct. No filler, no robotic disclaimers. If you don't have enough data, say so and say what you'd need.
- Use the server's custom emojis (injected below) naturally where they fit — they're encouraged.`;

const MAX_ITERATIONS = 20;

export interface TriggeringUser {
  id: string;
  username: string;
  displayName?: string | null;
  roles: { id: string; name: string }[];
  isModerator: boolean;
}

export interface ChannelContext {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  topic?: string | null;
  categoryName?: string | null;
  parentChannelId?: string | null;
  parentChannelName?: string | null;
}

export interface AgentLoopOptions {
  threadContext?: string;
  currentChannelId?: string;
  emojiMap?: Record<string, string>;
  mentionedUsers?: Map<string, UserNames>;
  botId?: string;
  botUsername?: string;
  triggeringUser?: TriggeringUser;
  currentChannel?: ChannelContext;
  serverContext?: string | null;
  memoryIndex?: string[]; // titles only — agent fetches content via read_memory
  memoryCount?: number;
  memoryLimit?: number;
  onInterimText?: (text: string) => Promise<void>;
  /** Called each iteration with the current batch of tool calls being dispatched. When provided, tool lines are omitted from the final footer. */
  onToolsDispatched?: (tools: { name: string; input: Record<string, unknown> }[]) => Promise<void>;
  /** Called before each generateText call to drain messages queued mid-loop by the user. */
  dequeueMessages?: () => { query: string; mentionedUsers?: Map<string, UserNames> }[];
  /** Called before each iteration; return true to abort the loop early. */
  isCancelled?: () => boolean;
}

export type { UserNames };

function buildUserNote(novel: [string, UserNames][]): string {
  const lines = novel.map(([id, names]) => {
    const parts = [names.username, names.displayName].filter(Boolean);
    return `• u:${id} = ${parts.join(" / ") || "(unknown)"}`;
  });
  return `[Internal: user identity mappings for resolving names — do not quote or surface this to the user]\n${lines.join("\n")}`;
}

export function buildSystemPrompt(opts: AgentLoopOptions = {}): string {
  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const systemParts = [BEHAVIOR_INSTRUCTIONS, `Current date: ${currentDate}. Use this only for interpreting relative time references in user messages (e.g. "yesterday", "last week"). Do NOT use it to compute or write timestamp math in your responses — always use Discord timestamp format instead.`];

  // Bot's own identity
  if (opts.botId) {
    const nameStr = opts.botUsername ? ` (${opts.botUsername})` : "";
    systemParts.push(`Your identity: Your Discord user ID is ${opts.botId}${nameStr}. When you see u:${opts.botId} in messages, that is yourself. Never confuse your own messages with those of other users.`);
  }

  // Current channel context
  if (opts.currentChannel) {
    const ch = opts.currentChannel;
    const privacy = ch.isPrivate ? "private (not visible to regular members)" : "public";
    const lines = [`Current channel: #${ch.name} (c:${ch.id}) — ${ch.type}, ${privacy}`];
    if (ch.categoryName) lines.push(`Category: ${ch.categoryName}`);
    if (ch.parentChannelName) lines.push(`Parent channel: #${ch.parentChannelName}`);
    if (ch.topic) lines.push(`Topic: ${ch.topic}`);
    systemParts.push(lines.join("\n"));
  }

  // Triggering user context
  if (opts.triggeringUser) {
    const u = opts.triggeringUser;
    const displayStr = u.displayName && u.displayName !== u.username ? ` (display name: ${u.displayName})` : "";
    const modStr = u.isModerator ? "yes — has moderation role" : "no";
    const roleStr = u.roles.length > 0
      ? u.roles.map((r) => `${r.name} (${r.id})`).join(", ")
      : "none";
    const lines = [
      `Request from: ${u.username}${displayStr} (u:${u.id})`,
      `Moderator: ${modStr}`,
      `Roles: ${roleStr}`,
    ];
    systemParts.push(lines.join("\n"));
  }

  // Server context (always injected, full content)
  if (opts.serverContext) {
    systemParts.push(`## Server Context\n${opts.serverContext}`);
  } else if (opts.serverContext === null) {
    systemParts.push(
      `## Server Context\nNot configured. At the start of this conversation, let the moderator know and suggest they type \`scan server\` so you can learn the server structure. You can still help with queries, but your awareness of this server will be limited until the scan is done.`,
    );
  }

  // Memory index (titles only — agent fetches full content via read_memory when relevant)
  if (opts.memoryIndex !== undefined) {
    const limit = opts.memoryLimit ?? 25;
    const count = opts.memoryCount ?? opts.memoryIndex.length;
    const header = `## Agent Memory (${count}/${limit} entries)`;
    const body =
      opts.memoryIndex.length > 0
        ? opts.memoryIndex.map((t, i) => `${i + 1}. "${t}"`).join("\n")
        : "(empty)";
    systemParts.push(
      `${header}\nCheck this index at the start of each conversation. If any entries look relevant to the current query, call read_memory to fetch their content before proceeding. Use write_memory to save things worth remembering across conversations — recurring patterns, corrections, important context. Update existing entries rather than duplicating. Use delete_memory for stale or resolved entries.\n\n${body}`,
    );
  }

  if (opts.emojiMap && Object.keys(opts.emojiMap).length > 0) {
    const entries = Object.entries(opts.emojiMap)
      .map(([name]) => `e:${name}`)
      .join("  ");
    systemParts.push(
      `Server emojis — use as \`e:name\` tokens (e.g. \`e:JennieLmao2\`). Available:\n${entries}\nDo not use other emojis. Do not include angle brackets or IDs — the bot expands \`e:name\` to the correct Discord syntax automatically.`,
    );
  }

  if (opts.threadContext) {
    const channelNote = opts.currentChannelId
      ? `\nThread channel ID: ${opts.currentChannelId} — if the thread has more history than shown above, use fetch_channel_messages with this channel_id and before=<earliest_message_id_above> to retrieve older messages.`
      : "";
    systemParts.push(`Current thread messages (all participants including bots, excluding your own prior replies):${channelNote}\n\n${opts.threadContext}`);
  }

  return systemParts.join("\n\n---\n\n");
}

export interface AgentLoopResult {
  response: string;
  updatedHistory: ModelMessage[];
  pendingQuestion?: PendingQuestion;
  cancelled: boolean;
}

export async function runAgentLoop(
  query: string,
  existingHistory: ModelMessage[],
  guildId: string,
  client: Client<true>,
  opts: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  return tracer.startActiveSpan("agent.loop", {
    attributes: {
      "agent.model": config.openaiModel,
      "agent.history_length": existingHistory.length,
      "agent.guild_id": guildId,
    },
  }, async (span) => {
    const systemPrompt = buildSystemPrompt(opts);

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: systemPrompt,
        // Cache the system prompt — it's the largest static block and identical
        // across all iterations within a single agent loop run.
        providerOptions: {
          openrouter: { cacheControl: { type: "ephemeral" } },
        },
      },
      ...existingHistory,
    ];

    const knownUsers = new Map<string, UserNames>();

    // Seed knownUsers from ALL system messages in existing history so we don't re-inject
    // identity notes for users already noted in prior turns — both mentionedUsers and
    // tool-discovered users (whose IDs appear as <@id> in [Internal: user identity mappings] notes).
    for (const msg of messages) {
      if (msg.role !== "system") continue;
      const text = typeof msg.content === "string" ? msg.content : null;
      if (!text) continue;
      for (const [, id] of text.matchAll(/<@(\d+)>/g)) {
        if (!knownUsers.has(id)) {
          knownUsers.set(id, opts.mentionedUsers?.get(id) ?? { username: "(unknown)", displayName: null });
        }
      }
    }

    if (opts.mentionedUsers?.size) {
      const novel = [...opts.mentionedUsers.entries()].filter(([id]) => !knownUsers.has(id));
      if (novel.length > 0) {
        for (const [id, userNames] of novel) knownUsers.set(id, userNames);
        messages.push({ role: "system", content: buildUserNote(novel) });
        logger.debug({ count: novel.length }, "injected mention user note");
      }
    }

    messages.push({ role: "user", content: query });

    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let lastInputTokens = 0;
    let cancelled = false;
    const usedTools: { name: string; input: Record<string, unknown> }[] = [];
    logger.info({ historyLength: existingHistory.length, knownUsers: knownUsers.size }, "starting loop");

    try {
      while (iterations < MAX_ITERATIONS) {
        if (opts.isCancelled?.()) {
          cancelled = true;
          logger.info({ iteration: iterations }, "loop cancelled by user");
          break;
        }

        iterations++;
        logger.debug({ iteration: iterations }, "iteration");

        // Inject any messages queued by the user while the previous iteration was running
        if (opts.dequeueMessages) {
          const pending = opts.dequeueMessages();
          for (const { query: pendingQuery, mentionedUsers: pendingUsers } of pending) {
            if (pendingUsers?.size) {
              const novel = [...pendingUsers.entries()].filter(([id]) => !knownUsers.has(id));
              if (novel.length > 0) {
                for (const [id, names] of novel) knownUsers.set(id, names);
                messages.push({ role: "system", content: buildUserNote(novel) });
              }
            }
            messages.push({ role: "user", content: pendingQuery });
            logger.info({ query: pendingQuery.slice(0, 80) }, "injected mid-loop message");
          }
        }

        const result = await generateText({
          model: openaiProvider(config.openaiModel),
          messages,
          tools: AI_TOOLS,
          maxOutputTokens: 4096,
          experimental_telemetry: {
            isEnabled: true,
            functionId: "agent-loop",
            metadata: { guildId, iteration: iterations },
          },
          ...(opts.currentChannelId ? { providerOptions: { openrouter: { session_id: opts.currentChannelId } } } : {}),
        });

        const { text, toolCalls, finishReason, usage } = result;

        if (usage) {
          totalInputTokens += usage.inputTokens ?? 0;
          totalOutputTokens += usage.outputTokens ?? 0;
          totalCacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
          totalCacheWriteTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
          lastInputTokens = usage.inputTokens ?? 0;
          logger.debug({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.inputTokenDetails?.cacheReadTokens, cacheWrite: usage.inputTokenDetails?.cacheWriteTokens }, "tokens");
        }

        if (opts.isCancelled?.()) {
          cancelled = true;
          logger.info({ iteration: iterations }, "loop cancelled by user (post-generation)");
          break;
        }

        if (finishReason === "stop" || !toolCalls?.length) {
          messages.push({ role: "assistant", content: text });
          const content = expandDiscordTokens(fixBlockquotes(text || "(no response)"), opts.emojiMap);
          const footerTools = opts.onToolsDispatched ? [] : usedTools;
          const footer = buildFooter(config.openaiModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, lastInputTokens, config.openaiContextLimit, footerTools);
          logger.info({ iterations, responseLength: content.length }, "done");
          return { response: `${content}\n\n---\n${footer}`, updatedHistory: messages.slice(1), cancelled: false };
        }

        if (finishReason === "tool-calls" && toolCalls.length > 0) {
          const names = toolCalls.map((t) => t.toolName).join(", ");
          logger.debug({ tools: names }, "tool calls");
          const dispatchedTools = toolCalls.map((tc) => ({ name: tc.toolName, input: tc.input as Record<string, unknown> }));
          for (const tool of dispatchedTools) {
            usedTools.push(tool);
          }

          if (opts.onToolsDispatched) {
            await opts.onToolsDispatched(dispatchedTools);
          }

          if (text && !text.startsWith("[Internal:") && opts.onInterimText) {
            await opts.onInterimText(expandDiscordTokens(fixBlockquotes(text), opts.emojiMap));
          }

          // Add assistant message with tool calls to history
          messages.push({
            role: "assistant",
            content: toolCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input as Record<string, unknown>,
            })),
          });

          const { toolMessage, discoveredUsers, pendingImages, pendingQuestion } = await tracer.startActiveSpan(
            "agent.tool_calls",
            { attributes: { "agent.tools": names, "agent.iteration": iterations } },
            async (toolSpan) => {
              try {
                return await runTools(toolCalls as { toolCallId: string; toolName: string; input: Record<string, unknown> }[], guildId, client);
              } finally {
                toolSpan.end();
              }
            },
          );

          messages.push(toolMessage);

          // ask_question — pause loop and return to let the bot send buttons
          if (pendingQuestion) {
            logger.info({ question: pendingQuestion.question }, "pausing loop for ask_question");
            span.setAttribute("agent.paused_for_question", true);
            return { response: "", updatedHistory: messages.slice(1), pendingQuestion, cancelled: false };
          }

          if (pendingImages.length > 0) {
            messages.push({
              role: "user",
              content: pendingImages.map((url) => ({ type: "image" as const, image: url })),
            });
            logger.debug({ count: pendingImages.length }, "injected images for inspection");
          }

          const novel = [...discoveredUsers.entries()].filter(([id]) => !knownUsers.has(id));
          if (novel.length > 0) {
            for (const [id, userNames] of novel) knownUsers.set(id, userNames);
            messages.push({ role: "system", content: buildUserNote(novel) });
            logger.debug({ count: novel.length }, "injected user note for new users");
          }

          continue;
        }

        // Unexpected finish reason
        logger.warn({ finishReason }, "unexpected finish_reason, treating as final");
        messages.push({ role: "assistant", content: text });
        const content = expandDiscordTokens(fixBlockquotes(text || "(no response)"), opts.emojiMap);
        const footer = buildFooter(config.openaiModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, lastInputTokens, config.openaiContextLimit, opts.onToolsDispatched ? [] : usedTools);
        return { response: `${content}\n\n---\n${footer}`, updatedHistory: messages.slice(1), cancelled: false };
      }

      if (cancelled) {
        return { response: "", updatedHistory: messages.slice(1), cancelled: true };
      }

      // Hit iteration limit — inject a wrap-up prompt and do one final generation with no tools
      logger.warn({ iterations }, "agent loop hit iteration limit, forcing final response");
      messages.push({ role: "system", content: "[System: You have reached the maximum number of steps. Stop using tools and give your best final response to the user now based on what you have gathered so far.]" });
      const finalResult = await generateText({
        model: openaiProvider(config.openaiModel),
        messages,
        maxOutputTokens: 4096,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "agent-loop",
          metadata: { guildId, iteration: iterations, forced: true },
        },
        ...(opts.currentChannelId ? { providerOptions: { openrouter: { session_id: opts.currentChannelId } } } : {}),
      });
      if (finalResult.usage) {
        totalInputTokens += finalResult.usage.inputTokens ?? 0;
        totalOutputTokens += finalResult.usage.outputTokens ?? 0;
        totalCacheReadTokens += finalResult.usage.inputTokenDetails?.cacheReadTokens ?? 0;
        totalCacheWriteTokens += finalResult.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
        lastInputTokens = finalResult.usage.inputTokens ?? 0;
      }
      messages.push({ role: "assistant", content: finalResult.text });
      const forcedContent = expandDiscordTokens(fixBlockquotes(finalResult.text || "(no response)"), opts.emojiMap);
      const footer = buildFooter(config.openaiModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, lastInputTokens, config.openaiContextLimit, opts.onToolsDispatched ? [] : usedTools);
      return { response: `${forcedContent}\n\n---\n${footer}`, updatedHistory: messages.slice(1), cancelled: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : errMsg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      throw err;
    } finally {
      span.setAttribute("agent.iterations", iterations);
      span.setAttribute("agent.input_tokens", totalInputTokens);
      span.setAttribute("agent.output_tokens", totalOutputTokens);
      span.end();
    }
  });
}

export function formatToolArg(value: unknown): string {
  if (typeof value === "string") {
    const truncated = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `"${truncated}"`;
  }
  return JSON.stringify(value);
}

/** Returns [inputPricePerM, outputPricePerM] in USD for known model name patterns. */
function modelPricing(model: string): [number, number] | null {
  const m = model.toLowerCase();
  if (m.includes("opus")) return [15, 75];
  if (m.includes("sonnet")) return [3, 15];
  if (m.includes("haiku")) return [0.8, 4];
  return null;
}

function buildFooter(
  model: string,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalCacheReadTokens: number,
  totalCacheWriteTokens: number,
  contextTokens: number,
  contextLimit: number,
  usedTools: { name: string; input: Record<string, unknown> }[],
): string {
  const ctxPct = Math.round((contextTokens / contextLimit) * 100);
  const pricing = modelPricing(model);
  const costStr = pricing
    ? ` · $${((totalInputTokens / 1_000_000) * pricing[0] + (totalOutputTokens / 1_000_000) * pricing[1]).toFixed(4)}`
    : "";
  const cacheStr =
    totalCacheReadTokens > 0 || totalCacheWriteTokens > 0
      ? ` · cache ${totalCacheReadTokens.toLocaleString()}r ${totalCacheWriteTokens.toLocaleString()}w`
      : "";
  const statsLine = `-# ${model} · ${contextTokens.toLocaleString()} ctx (${ctxPct}%) · ${totalOutputTokens.toLocaleString()} out${cacheStr}${costStr}`;
  if (usedTools.length === 0) return statsLine;

  const toolLines = usedTools.map(({ name, input }) => {
    const args = Object.entries(input)
      .map(([k, v]) => `${k}=${formatToolArg(v)}`)
      .join(", ");
    return `-# - ${args ? `${name}(${args})` : name}`;
  });
  return `${statsLine}\n${toolLines.join("\n")}`;
}

/** Fix bare ">" lines so Discord renders them as empty blockquote continuation lines. */
function fixBlockquotes(text: string): string {
  return text.replace(/^>$/gm, "> ");
}

/**
 * Expand short-prefix tokens the model outputs into Discord-rendered syntax.
 * The model writes u:ID, c:ID, t:SECONDS:FLAG, e:name — we expand them here so the
 * model never has to produce angle-bracket syntax directly.
 */
function expandDiscordTokens(text: string, emojiMap?: Record<string, string>): string {
  let result = text
    .replace(/\bu:(\d{15,20})\b/g, "<@$1>")
    .replace(/\bc:(\d{15,20})\b/g, "<#$1>")
    .replace(/\bt:(\d{8,12}):([A-Za-z])\b/g, "<t:$1:$2>");

  if (emojiMap) {
    result = result.replace(/\be:(\w+)\b/g, (match, name) => emojiMap[name] ?? match);
  }

  return result;
}

export function expandMessageLinks(text: string, guildId: string): string {
  return text.replace(
    /msg:(\d+)\/(\d+)/g,
    (_, channelId, messageId) =>
      `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  );
}
