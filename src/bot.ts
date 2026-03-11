import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { config } from "./config.ts";
import {
  insertMessage,
  updateMessageContent,
  softDeleteMessage,
  deleteOldMessages,
} from "./db/messages.ts";
import { loadConversation, saveConversation } from "./db/conversations.ts";
import { runAgentLoop } from "./agent/loop.ts";
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
  // Ignore DMs, bots, and guilds not in config
  if (!message.guildId || message.author.bot) return;

  const guildConfig = config.guildConfig[message.guildId];
  if (!guildConfig) return;

  // Cache every message from configured guilds
  insertMessage(message);

  // Only respond to mentions
  if (!message.mentions.has(client.user!.id)) return;

  // Whitelist checks
  if (!guildConfig.allowedUsers.includes(message.author.id)) return;

  const isAllowedChannel = isChannelAllowed(message, guildConfig.allowedChannels);
  if (!isAllowedChannel) return;

  const query = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!query) return;

  try {
    const { thread, isNew } = await resolveOrCreateThread(message);
    const existingHistory = loadConversation(thread.id);

    const { response, updatedHistory } = await runAgentLoop(
      query,
      existingHistory,
      message.guildId,
      client as Client<true>,
    );

    for (const chunk of splitMessage(response)) {
      await thread.send(chunk);
    }

    saveConversation(thread.id, message.guildId, updatedHistory);

    if (isNew) {
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

function isChannelAllowed(message: Message, allowedChannels: string[]): boolean {
  if (allowedChannels.includes(message.channelId)) return true;

  // Allow threads whose parent channel is whitelisted
  if (message.channel.isThread()) {
    const parentId = message.channel.parentId;
    return !!parentId && allowedChannels.includes(parentId);
  }

  return false;
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
