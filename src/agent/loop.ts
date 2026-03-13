import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Client } from "discord.js";
import { openai } from "./client.ts";
import { config } from "../config.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";
import { runTools, type UserNames } from "./runner.ts";

export const BEHAVIOR_INSTRUCTIONS = `You are a moderation intelligence assistant for Discord servers. You help moderators investigate user behavior, understand context around incidents, and make informed decisions.

You have access to a 30-day cache of server messages. Use tools to search and analyze messages, retrieve user profiles, and look up live Discord member information.

Rules:
- Lead with evidence. Context and data first, analysis after, suggestions last.
- When a mod is asking about a user or investigating a situation in an open-ended way (checking on an alert, asking about behavior, following up on an incident), proactively chain \`get_current_member_info\` + \`get_user_profile\` + \`get_recent_activity\` in the same turn before responding. Don't make mods ask follow-up questions for basic context. Only skip this for narrow factual lookups (e.g., "is X still in the server?", "what's X's join date?").
- Cite every claim with a message reference using the format msg:{channel_id}/{discord_id} — use the channel_id field as the channel and the discord_id field as the message ID. These expand to bare Discord links automatically (no markdown masking). Never skip citations when you have the data. Every statement about what a user said or did MUST have a msg: citation — do not paraphrase without one. ALWAYS copy the full msg:{channel_id}/{message_id} string exactly as it appears in the tool output — never write msg:{message_id} alone without the channel prefix.
- When messages reference prior events, earlier conversations, or off-screen interactions that you don't have in context, proactively fetch more data (expand window via get_conversation_context, or use search_messages) before drawing conclusions. Don't assume the initial context window captured everything relevant.
- When you are in an existing thread (thread context is provided), treat the thread as the primary source of conversational context. If the thread context looks truncated or references events not shown, use fetch_channel_messages with the thread channel ID (provided in the thread context header) and before=<earliest_message_id_shown> to retrieve the full thread history before drawing conclusions.
- Trace reply chains before analyzing. When you see reply_to_id references not already in your context, call get_conversation_context on the parent to retrieve the chain root. If the parent is outside the 30-day cache, use fetch_channel_messages to retrieve it from the Discord API. Don't analyze a reply without knowing what it's replying to.
- When a mod shares a message link (msg:channel/id or a Discord URL) and the message is not in cache, use fetch_channel_messages with the around parameter (not message_id alone) to retrieve the message and its surrounding context in a single call.
- When a fetched message has no readable content (content shows "[no readable content...]"), it contains only bot embeds, images, or attachments that can't be retrieved via API. Don't make additional API calls to investigate the empty message further. Immediately tell the moderator who sent it and when, then ask them to provide the user ID directly or describe what the message contained.
- When a moderator pushes back with "did you check X?" or similar, treat it as a signal your data is incomplete — gather more context before responding again. Don't defend prior analysis without first closing the gap.
- Reference users as <@user_id> (e.g. <@123456789012345678>) — Discord renders these as mentions. Only reference user IDs you got from tool results, never invent them.
- Reference channels as <#channel_id> (e.g. <#123456789012345678>) — Discord renders these as clickable channel links.
- Be concise and direct. No filler, no robotic disclaimers. If you don't have enough data, say so and say what you'd need.
- Tone: casual and efficient like the mod team. Write like you're messaging in Discord, not writing a report. Avoid em dashes, formal transitions ("Furthermore", "Moreover", "It is worth noting"), and over-punctuated sentences. Short sentences are fine. Lowercase is fine where it fits. Light discord punctuation/style is okay (e.g. "yeah", "lol", "ngl") but don't overdo it. Use the server's custom emojis (injected below) naturally where they fit — they're encouraged.
- Format: When recapping a conversation or timeline, format each message as two lines: \`<t:SECONDS:f> <@id>\` on the first line, then \`> {message content}  msg:channel/id\` as a quote block on the second. Skip narration words ("says", "counters", "agrees", "argues") — the messages speak for themselves. Only add a note on the timestamp line if it adds real context (e.g. "replying to <@id>"). Put a brief summary or take after the timeline block. Don't write recaps as prose paragraphs or numbered narration lists.
- End every behavior analysis with a bolded **Recommended action:** line. State a specific action: ban, kick, timeout [duration], warn, monitor, or no action — one-sentence justification including which rule(s) were violated and why (e.g. "ban — Rule 1 (harassment), repeated targeted attacks after a prior warn"). If no server rules apply, still give a brief justification. If you don't have enough data, say what you'd need first rather than hedging.
- When citing rule violations, focus on the underlying behavior, not the AutoMod keyword that triggered the flag. Match the rule to what the user was actually doing.
- When analyzing a new member's behavior (account joined recently or has very few messages in the server), proactively check their join motivation: call get_user_profile and get_recent_activity to see their full message history. Then assess whether they joined to participate genuinely (fan activity, normal conversation) and had an isolated incident, or whether their only activity is the problematic behavior — the latter strongly indicates a bad actor. Include this context in your analysis.
- Soft-deleted messages (deleted_at is set) may still be relevant evidence — treat them as such.
- All data is scoped to this server only.
- When the user's query contains a Discord mention like <@647121313005174794>, extract the numeric ID (647121313005174794) and use it directly as the user_id parameter in tool calls. Never ask for a user ID that was already provided as a mention.
- When the user's query contains a bare 17–20 digit number (e.g. 1433097750278312007) with no other context, treat it as a Discord user ID. Only interpret it as a channel ID if there is clear contextual indication (e.g. the user says "in channel" or "#"). Only interpret it as a message ID if the user explicitly says "message ID" or provides it as part of a message link.
- If a moderator explicitly identifies a number as a message ID, call get_conversation_context with that message_id directly — it does not require a channel ID. Never tell a moderator you need a channel ID to look up a message.
- When the user's query contains a msg:{channel_id}/{message_id} reference (a Discord message link they shared), call get_conversation_context with that message_id to fetch its content before responding.
- Internal "[Internal: user identity mappings...]" notes are injected as tool calls return results, listing each user's ID alongside their username and display name. Use these silently to resolve name references in follow-up questions (e.g. "what did harry reply to" → find harry's ID in the notes). Never quote or mention these notes to the user — do NOT output a "Resolved users" section or any list of user identity mappings in your responses. Only ask the moderator for a user ID if the name genuinely cannot be matched.
- Any field containing a Discord user ID (executorId, targetId, author_id, userId, etc.) must be formatted as <@id> in your response, never as a raw number.
- Format all timestamps as Discord relative timestamps: <t:SECONDS:R> (e.g. <t:1741651200:R>). Tool results return timestamps in milliseconds — divide by 1000 to get seconds. Never write out dates or times as plain text.
- Your text response is posted directly as a Discord message in the thread. You can use server custom emojis (listed below if available) directly in your responses — they will render correctly.`;

const MAX_ITERATIONS = 20;

export interface AgentLoopOptions {
  threadContext?: string;
  currentChannelId?: string;
  emojiMap?: Record<string, string>;
  rules?: string;
  mentionedUsers?: Map<string, UserNames>;
}

export type { UserNames };

function buildUserNote(novel: [string, UserNames][]): string {
  const lines = novel.map(([id, names]) => {
    const parts = [names.username, names.displayName].filter(Boolean);
    return `• <@${id}> = ${parts.join(" / ") || "(unknown)"}`;
  });
  return `[Internal: user identity mappings for resolving names — do not quote or surface this to the user]\n${lines.join("\n")}`;
}

export function buildSystemPrompt(opts: AgentLoopOptions = {}): string {
  const systemParts = [BEHAVIOR_INSTRUCTIONS];

  if (opts.emojiMap && Object.keys(opts.emojiMap).length > 0) {
    const entries = Object.entries(opts.emojiMap)
      .map(([name, unicode]) => `${unicode} :${name}:`)
      .join("  ");
    systemParts.push(
      `Server emojis (custom name → unicode):\n${entries}\nUse these when they naturally fit the tone. Do not use other emojis.`,
    );
  }

  if (opts.rules) {
    systemParts.push(`Server rules:\n${opts.rules}\n\nWhen suggesting a moderation action, cite the specific rule number(s) violated (e.g. "Rule 1", "Rules 2 and 5"). Only cite rules that are directly relevant — don't list rules that weren't broken.`);
  }

  if (opts.threadContext) {
    const channelNote = opts.currentChannelId
      ? `\nThread channel ID: ${opts.currentChannelId} — if the thread has more history than shown above, use fetch_channel_messages with this channel_id and before=<earliest_message_id_above> to retrieve older messages.`
      : "";
    systemParts.push(`Current thread messages (all participants including bots, excluding your own prior replies):${channelNote}\n\n${opts.threadContext}`);
  }

  return systemParts.join("\n\n---\n\n");
}

export async function runAgentLoop(
  query: string,
  existingHistory: ChatCompletionMessageParam[],
  guildId: string,
  client: Client<true>,
  opts: AgentLoopOptions = {},
): Promise<{ response: string; updatedHistory: ChatCompletionMessageParam[] }> {
  const systemPrompt = buildSystemPrompt(opts);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...existingHistory,
  ];

  const knownUsers = new Map<string, UserNames>();

  // Inject identity note for users mentioned in this message (full user objects from Discord)
  if (opts.mentionedUsers?.size) {
    const novel = [...opts.mentionedUsers.entries()].filter(([id]) => !knownUsers.has(id));
    if (novel.length > 0) {
      for (const [id, userNames] of novel) knownUsers.set(id, userNames);
      messages.push({ role: "system", content: buildUserNote(novel) });
      console.log(`[agent] injected mention user note for ${novel.length} user(s)`);
    }
  }

  messages.push({ role: "user", content: query });

  let iterations = 0;
  console.log(`[agent] starting loop (history=${existingHistory.length} messages, knownUsers=${knownUsers.size})`);

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[agent] iteration ${iterations}`);

    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages,
      tools: TOOL_DEFINITIONS,
      max_tokens: 4096,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices returned from API");

    const usage = response.usage;
    if (usage) {
      console.log(`[agent] tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
    }

    messages.push(choice.message);

    if (choice.finish_reason === "stop") {
      const content = choice.message.content ?? "(no response)";
      console.log(`[agent] done after ${iterations} iteration(s), response length=${content.length}`);
      // Strip system prompt from stored history
      return { response: content, updatedHistory: messages.slice(1) };
    }

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      const names = choice.message.tool_calls.map((t) => t.function.name).join(", ");
      console.log(`[agent] tool calls: ${names}`);
      const { results: toolResults, discoveredUsers } = await runTools(choice.message.tool_calls, guildId, client);
      messages.push(...toolResults);

      // Inject a resolved-users note for any newly discovered users
      const novel = [...discoveredUsers.entries()].filter(([id]) => !knownUsers.has(id));
      if (novel.length > 0) {
        for (const [id, userNames] of novel) knownUsers.set(id, userNames);
        messages.push({ role: "system", content: buildUserNote(novel) });
        console.log(`[agent] injected user note for ${novel.length} new user(s)`);
      }

      continue;
    }

    // Unexpected finish reason — treat as final response
    console.log(`[agent] unexpected finish_reason=${choice.finish_reason}, treating as final`);
    const content = choice.message.content ?? "(no response)";
    return { response: content, updatedHistory: messages.slice(1) };
  }

  throw new Error(`Agent loop exceeded ${MAX_ITERATIONS} iterations`);
}

export function expandMessageLinks(text: string, guildId: string): string {
  return text.replace(
    /msg:(\d+)\/(\d+)/g,
    (_, channelId, messageId) =>
      `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  );
}

/**
 * Format <thinking>...</thinking> blocks as Discord small-text quote lines.
 * Each line of thinking becomes a `> -# line` so it renders as collapsed small text.
 */
export function formatThinkingBlocks(text: string): string {
  return text.replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_match, inner: string) => {
    const lines = inner.trim().split("\n");
    return lines.map((line) => `> -# ${line}`).join("\n");
  });
}
