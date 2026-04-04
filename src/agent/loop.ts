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
- Every statement about what a user said or did requires a msg:{channel_id}/{message_id} citation — copy the format exactly from tool output (never omit the channel prefix). These expand to clickable Discord links automatically. Don't paraphrase without a citation.
- When evaluating an AutoMod flag, treat the block and the punishment as two separate questions. The block may be technically correct (keyword policy working as intended) while the timeout is still worth reviewing. Always establish *why* the user said what they said — were they quoting something, reacting to content directed at them, discussing context, etc. — before assessing culpability. Never call AutoMod a "false positive" just because the user wasn't being malicious; instead, address the punishment separately.
- When messages reference prior events, earlier conversations, or off-screen interactions that you don't have in context, proactively fetch more data (expand window via get_conversation_context, or use search_messages) before drawing conclusions. Don't assume the initial context window captured everything relevant.
- When you are in an existing thread (thread context is provided), treat the thread as the primary source of conversational context. If the thread context looks truncated or references events not shown, use fetch_channel_messages with the thread channel ID (provided in the thread context header) and before=<earliest_message_id_shown> to retrieve the full thread history before drawing conclusions.
- Trace reply chains before analyzing. When you see reply_to_id references not already in your context, call get_conversation_context on the parent to retrieve the chain root. If the parent is outside the 30-day cache, use fetch_channel_messages to retrieve it from the Discord API. Don't analyze a reply without knowing what it's replying to.
- When a mod shares a message link (msg:channel/id or a Discord URL) and the message is not in cache, fetch it using fetch_channel_messages — retrieve only what you need (the message itself, or surrounding context if the incident requires it).
- When a fetched message shows "[image: filename.ext]" and you need to assess its content (e.g. the mod asked to check or review the message), immediately call \`inspect_image\` — don't ask first.
- When a fetched message has no readable content (content shows "[no readable content...]"), it contains only bot embeds or non-image attachments that can't be retrieved via API. Don't make additional API calls to investigate the empty message further. Immediately tell the moderator who sent it and when, then ask them to provide the user ID directly or describe what the message contained.
- When a moderator pushes back with "did you check X?" or similar, treat it as a signal your data is incomplete — gather more context before responding again. Don't defend prior analysis without first closing the gap.
- Reference users as <@user_id> (e.g. <@123456789012345678>) — Discord renders these as mentions. Only reference user IDs you got from tool results, never invent them.
- Reference channels as <#channel_id> (e.g. <#123456789012345678>) — Discord renders these as clickable channel links.
- Be concise and direct. No filler, no robotic disclaimers. If you don't have enough data, say so and say what you'd need.
- Tone: casual and efficient like the mod team. Write like you're messaging in Discord, not writing a report. Avoid em dashes, formal transitions ("Furthermore", "Moreover", "It is worth noting"), and over-punctuated sentences. Short sentences are fine. Lowercase is fine where it fits. Light discord punctuation/style is okay (e.g. "yeah", "lol", "ngl") but don't overdo it. Use the server's custom emojis (injected below) naturally where they fit — they're encouraged.
- Format: Whenever you present message evidence — even a single message — use the two-line format with NO code backticks: <t:SECONDS:f> <@id> msg:channel/id on the first line, then > {message content} as a Discord quote block on the second. If the message spans multiple lines, prefix EVERY line with "> " including blank separator lines between paragraphs — use "> " with a trailing space, never a bare ">". Do not wrap the timestamp, mention, or message link in backticks — they must be raw Discord syntax so they render as clickable links and mentions. Never write prose descriptions of what a message said ("they said X", "the user wrote Y") — always show the message directly in this format. Skip narration words ("says", "counters", "agrees", "argues") — the messages speak for themselves. Only add a note on the timestamp line if it adds real context (e.g. "replying to <@id>", "bot response to .throw"). Put a brief summary or take after the evidence block, not before.
- When presenting a pattern of behavior, show the 3–5 most representative examples, not an exhaustive list. Pick the ones that best illustrate the issue and leave out duplicates or weaker instances.
- End every behavior analysis with a bolded **Recommended action:** line. State a specific action: ban, kick, timeout [duration], warn, monitor, or no action — one-sentence justification including which rule(s) were violated and why (e.g. "ban — Rule 1 (harassment), repeated targeted attacks after a prior warn"). If no server rules apply, still give a brief justification. If you don't have enough data, say what you'd need first rather than hedging.
- When drafting a warning or mod action message for the moderator to send: keep it to 2–3 sentences max. Lead with the rule number and a dash, then describe the specific behavior concisely (name the actual things they did, not abstract characterizations). One follow-up sentence if needed — e.g. a brief note on what's expected. No moralizing, no filler phrases ("isn't cool", "not okay", "please be aware", "this is your formal warning"). Tone: direct and matter-of-fact, not performatively stern or cringe-casual. Example format: "Rule 1 — repeatedly calling members 'weird', 'liars', and dismissing them as delusional over the past month. Being honest doesn't mean being condescending and please do not shame people."
- When citing rule violations, focus on the underlying behavior, not the AutoMod keyword that triggered the flag. Match the rule to what the user was actually doing.
- When analyzing a new member's behavior (account joined recently or has very few messages in the server), proactively check their join motivation: call get_user_profile and get_recent_activity to see their full message history. Then assess whether they joined to participate genuinely (fan activity, normal conversation) and had an isolated incident, or whether their only activity is the problematic behavior — the latter strongly indicates a bad actor. Include this context in your analysis.
- Soft-deleted messages (deleted_at is set) may still be relevant evidence — treat them as such.
- All data is scoped to this server only.
- Resolve IDs from user input: a <@mention> → extract and use the numeric user_id directly (never ask for it again); a bare 17–20 digit number → treat as user_id by default (channel ID only if context clearly says so, message ID only if the user says so); a msg:{channel_id}/{message_id} link → call get_conversation_context with the message_id. get_conversation_context doesn't require a channel_id — never tell a moderator you need one to look up a message.
- Internal "[Internal: user identity mappings...]" notes are injected as tool calls return results, listing each user's ID alongside their username and display name. Use these silently to resolve name references in follow-up questions (e.g. "what did harry reply to" → find harry's ID in the notes). Never quote or mention these notes to the user — do NOT output a "Resolved users" section or any list of user identity mappings in your responses. Only ask the moderator for a user ID if the name genuinely cannot be matched.
- Any field containing a Discord user ID (executorId, targetId, author_id, userId, etc.) must be formatted as <@id> in your response, never as a raw number.
- Format timestamps as Discord timestamps. Tool results return timestamps in milliseconds — divide by 1000 to get seconds. Never write out dates or times as plain text — not even approximations like "~11 days ago" or "2 months ago". You do not know what time it is; only Discord's client does. Use <t:SECONDS:f> (absolute) for message evidence lines and action timestamps like bans, timeouts, and audit log entries. Use <t:SECONDS:R> (relative) for contextual references like join dates, account ages, or last-seen times. Always let Discord render the relative time — never compute it yourself.
- Your text response is posted directly as a Discord message in the thread. You can use server custom emojis (listed below if available) directly in your responses — they will render correctly.
- Use \`---\` on its own line (with blank lines around it) to separate major sections of your response (e.g. evidence block from analysis, analysis from recommendation). Do NOT put \`---\` at the beginning or end of your response — only between sections. Example: evidence section, then \`\\n---\\n\`, then take/recommendation.`;

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
  const now = new Date();
  const currentDate = now.toISOString().split("T")[0]; // e.g. "2026-03-19"
  const systemParts = [BEHAVIOR_INSTRUCTIONS, `Current date: ${currentDate}. Use this only for interpreting relative time references in user messages (e.g. "yesterday", "last week"). Do NOT use it to compute or write timestamp math in your responses — always use Discord timestamp format instead.`];

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
  sessionId?: string,
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
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCost: number | null = null;
  console.log(`[agent] starting loop (history=${existingHistory.length} messages, knownUsers=${knownUsers.size})`);

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[agent] iteration ${iterations}`);

    const createParams = {
      model: config.openaiModel,
      messages,
      tools: TOOL_DEFINITIONS,
      max_tokens: 4096,
      ...(sessionId ? { session_id: sessionId } : {}),
    };
    const response = await openai.chat.completions.create(createParams as typeof createParams & { stream?: false });

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices returned from API");

    const usage = response.usage;
    if (usage) {
      totalPromptTokens += usage.prompt_tokens;
      totalCompletionTokens += usage.completion_tokens;
      const cost = (usage as unknown as Record<string, unknown>)["cost"];
      if (typeof cost === "number") totalCost = (totalCost ?? 0) + cost;
      console.log(`[agent] tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
    }

    messages.push(choice.message);

    if (choice.finish_reason === "stop") {
      const content = fixBlockquotes(choice.message.content ?? "(no response)");
      const footer = buildFooter(config.openaiModel, totalPromptTokens, totalCompletionTokens, totalCost);
      console.log(`[agent] done after ${iterations} iteration(s), response length=${content.length}`);
      // Strip system prompt from stored history
      return { response: `${content}\n${footer}`, updatedHistory: messages.slice(1) };
    }

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      const names = choice.message.tool_calls.map((t) => t.function.name).join(", ");
      console.log(`[agent] tool calls: ${names}`);
      const { results: toolResults, discoveredUsers, pendingImages } = await runTools(choice.message.tool_calls, guildId, client);
      messages.push(...toolResults);

      if (pendingImages.length > 0) {
        messages.push({
          role: "user",
          content: pendingImages.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        });
        console.log(`[agent] injected ${pendingImages.length} image(s) for inspection`);
      }

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
    const content = fixBlockquotes(choice.message.content ?? "(no response)");
    const footer = buildFooter(config.openaiModel, totalPromptTokens, totalCompletionTokens, totalCost);
    return { response: `${content}\n${footer}`, updatedHistory: messages.slice(1) };
  }

  throw new Error(`Agent loop exceeded ${MAX_ITERATIONS} iterations`);
}

function buildFooter(model: string, promptTokens: number, completionTokens: number, cost: number | null): string {
  const costStr = cost != null ? ` · $${cost.toFixed(4)}` : "";
  return `-# ${model} · ${promptTokens.toLocaleString()} in / ${completionTokens.toLocaleString()} out${costStr}`;
}

/** Fix bare ">" lines so Discord renders them as empty blockquote continuation lines. */
function fixBlockquotes(text: string): string {
  return text.replace(/^>$/gm, "> ");
}

export function expandMessageLinks(text: string, guildId: string): string {
  return text.replace(
    /msg:(\d+)\/(\d+)/g,
    (_, channelId, messageId) =>
      `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  );
}

