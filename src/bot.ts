import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Message,
  type MessageCreateOptions,
  type ThreadChannel,
} from "discord.js";
import { buildMessageContent } from "./utils/flattenMessage.ts";
import { config } from "./config.ts";
import {
  insertMessage,
  updateMessageContent,
  softDeleteMessage,
  deleteOldMessages,
} from "./db/messages.ts";
import { loadConversation, saveConversation } from "./db/conversations.ts";
import { runAgentLoop, expandMessageLinks, buildSystemPrompt, type UserNames } from "./agent/loop.ts";
import { TOOL_DEFINITIONS } from "./agent/tools.ts";
import { resolveOrCreateThread, renameThread } from "./threads/manager.ts";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (!message.guildId) return;

  const guildConfig = config.guildConfig[message.guildId];
  if (!guildConfig) return;

  // Cache every message from configured guilds, including bots (modmail, logs, etc.)
  insertMessage(message);

  // Don't trigger the agent on bot messages
  if (message.author.bot) return;

  // Respond to mentions or direct replies to the bot's messages
  const isMention = message.mentions.has(client.user!.id);
  const isReply = !isMention && (await isReplyToBot(message, client.user!.id));
  if (!isMention && !isReply) return;

  // Whitelist checks
  if (!message.member?.roles.cache.hasAny(...guildConfig.allowedRoles)) return;

  const isAllowedChannel = isChannelAllowed(message, guildConfig.allowedChannels);
  if (!isAllowedChannel) return;

  // Only strip the bot's own mention, preserve other user/channel mentions for the agent
  const rawQuery = message.content.replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  if (!rawQuery) return;

  // dump-chat: upload the stored conversation as an OpenAI-compatible JSON payload
  if (rawQuery.toLowerCase() === "dump-chat") {
    try {
      const { thread, isNew } = await resolveOrCreateThread(message);
      const { messages: history, initialThreadContext } = loadConversation(thread.id);
      const threadContext = initialThreadContext ?? (isNew ? "" : await fetchThreadContext(thread, client.user!.id));
      const systemPrompt = buildSystemPrompt({
        threadContext: threadContext || undefined,
        currentChannelId: thread.id,
        emojiMap: guildConfig.emojiMap,
        rules: guildConfig.rules,
      });
      const payload = {
        model: config.openaiModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
        ],
        tools: TOOL_DEFINITIONS,
        max_tokens: 4096,
      };
      const json = JSON.stringify(payload, null, 2);
      const buf = Buffer.from(json, "utf-8");
      await thread.send({
        content: `Conversation dump (${history.length} stored messages)`,
        files: [{ attachment: buf, name: `conversation-${thread.id}.json` }],
      });
    } catch (err) {
      console.error("Error handling dump-chat:", err);
      await message.reply("Failed to dump conversation.").catch(() => {});
    }
    return;
  }

  // Replace custom Discord emojis with their unicode equivalents for the agent
  const emojiQuery = guildConfig.emojiMap
    ? rawQuery.replace(/<a?:(\w+):\d+>/g, (match, name) => guildConfig.emojiMap![name] ?? match)
    : rawQuery;

  // Convert Discord message URLs to msg:{channel_id}/{message_id} so the agent can resolve them
  const normalizedQuery = emojiQuery.replace(
    /https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/g,
    "msg:$1/$2",
  );

  // Collect identity info for all mentioned users (full Discord objects available here)
  const mentionedUsers = new Map<string, UserNames>();
  for (const [userId, user] of message.mentions.users) {
    if (userId === client.user!.id) continue;
    const member = message.mentions.members?.get(userId);
    const displayName = member?.displayName ?? user.displayName;
    mentionedUsers.set(userId, {
      username: user.username,
      displayName: displayName !== user.username ? displayName : null,
    });
  }

  // If the triggering message is a reply to a non-bot message, include that message as context
  let replyContext = "";
  if (isMention && message.reference?.messageId) {
    try {
      const refMsg =
        message.channel.messages.cache.get(message.reference.messageId) ??
        (await message.channel.messages.fetch(message.reference.messageId));
      if (refMsg.author.id !== client.user!.id) {
        const refContent = buildMessageContent(refMsg);
        replyContext = `[Replying to message from ${refMsg.author.username} (<@${refMsg.author.id}>)]\n${refContent}\n\n`;
        // Also collect identity info from the referenced message's mentions
        for (const [userId, user] of refMsg.mentions.users) {
          if (!mentionedUsers.has(userId)) {
            mentionedUsers.set(userId, {
              username: user.username,
              displayName: null,
            });
          }
        }
      }
    } catch {
      // Ignore fetch errors — proceed without context
    }
  }

  // Include author identity so the agent knows who "me" refers to
  const query = `${replyContext}[Message from ${message.author.username} (<@${message.author.id}>)]\n${normalizedQuery}`;

  const trigger = isMention ? "mention" : "reply";
  console.log(`[bot] triggered by ${trigger} from ${message.author.username} (${message.author.id}) in ${message.channelId}`);

  try {
    const { thread, isNew } = await resolveOrCreateThread(message);
    const { messages: existingHistory, initialThreadContext } = loadConversation(thread.id);
    // Use stored context on subsequent turns for stable prompt caching; only fetch on first invocation.
    // For new threads created from a non-thread channel, fetch recent parent channel messages as context
    // so the agent can see things like AutoMod alerts posted before the trigger message.
    let threadContext: string;
    if (initialThreadContext != null) {
      threadContext = initialThreadContext;
    } else if (isNew) {
      threadContext = await fetchParentChannelContext(message, client.user!.id);
    } else {
      threadContext = await fetchThreadContext(thread, client.user!.id);
    }

    await thread.sendTyping();
    const typingInterval = setInterval(() => thread.sendTyping(), 8000);

    let agentResult: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      agentResult = await runAgentLoop(
        query,
        existingHistory,
        message.guildId,
        client as Client<true>,
        {
          threadContext: threadContext || undefined,
          currentChannelId: thread.id,
          emojiMap: guildConfig.emojiMap,
          rules: guildConfig.rules,
          mentionedUsers: mentionedUsers.size ? mentionedUsers : undefined,
        },
      );
    } finally {
      clearInterval(typingInterval);
    }

    const { response, updatedHistory } = agentResult;
    const expanded = expandMessageLinks(response, message.guildId);
    for (const msgOpts of buildComponentMessages(expanded)) {
      await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
    }

    saveConversation(thread.id, message.guildId, updatedHistory, threadContext);

    // Rename thread when there's enough context:
    // - 3+ tool uses on first turn (rich investigation), OR
    // - any tool use on a follow-up turn (user sent another message, so we have more context)
    const toolUseCount = updatedHistory.filter((m) => m.role === "tool").length;
    const userTurnCount = updatedHistory.filter((m) => m.role === "user").length;
    const isDefaultName = thread.name === "sushii-agent investigation";
    const enoughContext = toolUseCount >= 3 || userTurnCount >= 2;
    if (toolUseCount > 0 && enoughContext && (isNew || isDefaultName)) {
      await renameThread(thread, updatedHistory);
    }
  } catch (err) {
    console.error("Error handling mention:", err);
    try {
      await message.reply("An error occurred while processing your request. Check the logs.");
    } catch {
      // Ignore reply errors
    }
  }
});

client.on(Events.MessageUpdate, (_old, newMsg) => {
  if (!newMsg.guildId) return;
  if (newMsg.partial) return;
  if (!newMsg.content) return;

  updateMessageContent(newMsg.id, newMsg.content, newMsg.editedTimestamp ?? Date.now());
});

client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;
  softDeleteMessage(message.id);
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Watching guilds: ${Object.keys(config.guildConfig).join(", ")}`);
});

async function isReplyToBot(message: Message, botId: string): Promise<boolean> {
  if (!message.reference?.messageId) return false;
  try {
    const ref =
      message.channel.messages.cache.get(message.reference.messageId) ??
      (await message.channel.messages.fetch(message.reference.messageId));
    return ref.author.id === botId;
  } catch {
    return false;
  }
}

function isChannelAllowed(message: Message, allowedChannels: string[]): boolean {
  if (allowedChannels.includes(message.channelId)) return true;

  // Allow threads whose parent channel is whitelisted
  if (message.channel.isThread()) {
    const parentId = message.channel.parentId;
    return !!parentId && allowedChannels.includes(parentId);
  }

  return false;
}

function formatMessageLine(m: Message): string {
  const ts = Math.floor(m.createdTimestamp / 1000);
  const authorLabel = m.author.bot ? `${m.author.username} [bot]` : m.author.username;
  const content = buildMessageContent(m);
  return `<t:${ts}:R> [${authorLabel}]: ${content}`;
}

async function fetchThreadContext(
  thread: ThreadChannel,
  botId: string,
  limit = 100,
): Promise<string> {
  const fetched = await thread.messages.fetch({ limit });
  const messages = [...fetched.values()]
    // Skip the bot's own messages — already present in existingHistory
    .filter((m) => m.author.id !== botId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  return messages.map(formatMessageLine).join("\n");
}

async function fetchParentChannelContext(
  triggerMessage: Message,
  botId: string,
  limit = 20,
): Promise<string> {
  if (triggerMessage.channel.isThread()) return "";

  const fetched = await triggerMessage.channel.messages.fetch({
    before: triggerMessage.id,
    limit,
  });

  const messages = [...fetched.values()]
    .filter((m) => m.author.id !== botId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  return messages.map(formatMessageLine).join("\n");
}

// Max characters per TextDisplay component (Discord limit)
const TEXT_DISPLAY_MAX = 4000;
// Max top-level components per message (Discord limit)
const MAX_COMPONENTS = 40;

type RawElement = { kind: "text"; content: string } | { kind: "separator" };

function parseElements(text: string): RawElement[] {
  // Strip leading and trailing dividers (useless at boundaries)
  const cleaned = text
    .replace(/^(\s*---\s*\n)+/, "")
    .replace(/(\n\s*---\s*)+$/, "")
    .trim();

  const elements: RawElement[] = [];
  const sections = cleaned.split(/\n---\n/);

  for (let i = 0; i < sections.length; i++) {
    if (i > 0) elements.push({ kind: "separator" });

    const section = sections[i].trim();
    if (!section) continue;

    if (section.length <= TEXT_DISPLAY_MAX) {
      elements.push({ kind: "text", content: section });
    } else {
      // Split oversized sections at newline boundaries
      let remaining = section;
      while (remaining.length > TEXT_DISPLAY_MAX) {
        const splitAt = remaining.lastIndexOf("\n", TEXT_DISPLAY_MAX);
        const cutAt = splitAt > 0 ? splitAt : TEXT_DISPLAY_MAX;
        elements.push({ kind: "text", content: remaining.slice(0, cutAt).trimEnd() });
        remaining = remaining.slice(cutAt).trimStart();
      }
      if (remaining) elements.push({ kind: "text", content: remaining });
    }
  }

  return elements;
}

function buildComponentMessages(text: string): MessageCreateOptions[] {
  const elements = parseElements(text);
  const messages: MessageCreateOptions[] = [];
  let components: (TextDisplayBuilder | SeparatorBuilder)[] = [];

  const flush = () => {
    if (components.length === 0) return;
    // Drop trailing separator before flushing
    while (components.length > 0 && components[components.length - 1] instanceof SeparatorBuilder) {
      components.pop();
    }
    if (components.length > 0) {
      messages.push({ components, flags: MessageFlags.IsComponentsV2 });
    }
    components = [];
  };

  for (const el of elements) {
    if (el.kind === "separator") {
      // Skip separator at start of a new message
      if (components.length === 0) continue;
      // Flush if no room for separator + at least one text after
      if (components.length >= MAX_COMPONENTS - 1) {
        flush();
        continue; // separator would be at start of new msg — skip it
      }
      components.push(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
    } else {
      if (components.length >= MAX_COMPONENTS) flush();
      components.push(new TextDisplayBuilder({ content: el.content }));
    }
  }

  flush();
  return messages;
}

export async function startBot(): Promise<void> {
  // Run cleanup on startup, then daily
  deleteOldMessages();
  setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);

  await client.login(config.discordBotToken);
}
