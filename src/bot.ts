import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
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
    // Use stored context on subsequent turns for stable prompt caching; only fetch on first invocation
    const threadContext = initialThreadContext ?? (isNew ? "" : await fetchThreadContext(thread, client.user!.id));

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
    for (const chunk of splitMessage(expanded)) {
      await thread.send({ content: chunk, allowedMentions: { parse: [] } });
    }

    saveConversation(thread.id, message.guildId, updatedHistory, threadContext);

    // Rename thread once there's real context (agent used a tool), even if not the first exchange
    const hasToolUse = updatedHistory.some((m) => m.role === "tool");
    const isDefaultName = thread.name === "sushii-agent investigation";
    if (hasToolUse && (isNew || isDefaultName)) {
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

  if (!messages.length) return "";

  return messages
    .map((m) => {
      const ts = Math.floor(m.createdTimestamp / 1000);
      const authorLabel = m.author.bot ? `${m.author.username} [bot]` : m.author.username;
      const content = buildMessageContent(m);
      return `<t:${ts}:R> [${authorLabel}]: ${content}`;
    })
    .join("\n");
}

function splitMessage(content: string, maxLength = 2000): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Prefer splitting at a newline boundary
    const splitAt = remaining.lastIndexOf("\n", maxLength);
    const cutAt = splitAt > 0 ? splitAt : maxLength;

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }

  return chunks;
}

export async function startBot(): Promise<void> {
  // Run cleanup on startup, then daily
  deleteOldMessages();
  setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);

  await client.login(config.discordBotToken);
}
