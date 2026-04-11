import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Message,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from "discord.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { buildMessageContent } from "./utils/flattenMessage.ts";
import { config } from "./config.ts";
import { getLogger } from "./logger.ts";
import {
  insertMessage,
  updateMessageContent,
  softDeleteMessage,
  deleteOldMessages,
} from "./db/messages.ts";
import { loadConversation, saveConversation, deleteStaleConversations } from "./db/conversations.ts";
import { savePendingQuestion, deletePendingQuestion, loadAllPendingQuestions, deleteStalePendingQuestions } from "./db/pendingQuestions.ts";
import { runAgentLoop, expandMessageLinks, buildSystemPrompt, type UserNames, type ChannelContext, type TriggeringUser, type AgentLoopResult } from "./agent/loop.ts";
import { saveFeedback } from "./feedback.ts";
import { getServerContext, listMemoryTitles, getMemoryCount, MEMORY_LIMIT } from "./db/memory.ts";
import { TOOL_DEFINITIONS } from "./agent/tools.ts";
import { resolveOrCreateThread, renameThread } from "./threads/manager.ts";
import { isPrivateChannel } from "./tools/channelUtils.ts";

const logger = getLogger("bot");
const tracer = trace.getTracer("sushii-agent");

// In-memory map of threadId → pending question state (restored from DB on startup)
interface PendingQuestionState {
  question: string;
  choices: string[];
  triggeredByUserId: string;
}
const pendingChoices = new Map<string, PendingQuestionState>();

// Per-channel async mutex to prevent concurrent agent runs in the same thread
const threadLocks = new Map<string, Promise<void>>();

function withThreadLock(threadId: string, fn: () => Promise<void>): Promise<void> {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (threadLocks.get(threadId) === next) {
      threadLocks.delete(threadId);
    }
  });
  threadLocks.set(threadId, next);
  return next;
}

// Custom ID prefix for ask_question button interactions
const ASK_BTN_PREFIX = "agq:";
// Custom ID prefix for initial server scan approval buttons
const SCAN_BTN_PREFIX = "srv:";
// Custom ID prefix for feedback thumbs up/down buttons
const FEEDBACK_BTN_PREFIX = "fb:";
// Custom ID prefix for feedback modal submissions: fbm:{threadId}:{sentiment}:{buttonMsgId}
const FEEDBACK_MODAL_PREFIX = "fbm:";

interface PendingScanState {
  threadId: string;
  guildId: string;
  query: string;
  threadContext: string;
  triggeringUser: TriggeringUser | undefined;
  currentChannel: ChannelContext | undefined;
  mentionedUsers?: Map<string, UserNames>;
}

// Per-guild pending scan approval state (cleared on approval or skip)
const pendingScans = new Map<string, PendingScanState>();

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
      logger.error({ err }, "Error handling dump-chat");
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
        replyContext = `Replying to u:${refMsg.author.id} (${refMsg.author.username}):\n${refContent}\n\n`;
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

  // Collect triggering user's roles for agent context
  const memberRoles = message.member
    ? [...message.member.roles.cache.values()]
        .filter((r) => r.id !== message.guild?.roles.everyone.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name }))
    : [];

  const isModerator = message.member?.roles.cache.hasAny(...guildConfig.allowedRoles) ?? false;

  const triggeringUser = {
    id: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName !== message.author.username ? message.member?.displayName : null,
    roles: memberRoles,
    isModerator,
  };

  const currentChannel = getChannelContext(message);

  const trigger = isMention ? "mention" : "reply";
  logger.info({ trigger, username: message.author.username, userId: message.author.id, channelId: message.channelId }, "triggered");

  await withThreadLock(message.channelId, async () => {
  await tracer.startActiveSpan("discord.message", {
    attributes: {
      "discord.guild_id": message.guildId ?? undefined,
      "discord.channel_id": message.channelId,
      "discord.message_id": message.id,
      "discord.user_id": message.author.id,
      "discord.trigger": trigger,
    },
  }, async (span) => {
    try {
      const { thread, isNew } = await resolveOrCreateThread(message);
      span.setAttribute("discord.thread_id", thread.id);

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

      const guildId = message.guildId!;
      const serverContext = getServerContext(guildId);

      if (serverContext === null) {
        if (pendingScans.has(guildId)) {
          await thread.send("A server scan is pending approval. Please re-ask after it completes.");
          return;
        }
        pendingScans.set(guildId, { threadId: thread.id, guildId, query, threadContext, triggeringUser, currentChannel, mentionedUsers: mentionedUsers.size ? mentionedUsers : undefined });
        await sendScanApprovalMessage(thread, guildId);
        return;
      }

      const memoryIndex = listMemoryTitles(guildId);
      const memoryCount = getMemoryCount(guildId);

      await thread.sendTyping();
      const typingInterval = setInterval(() => thread.sendTyping(), 8000);

      let agentResult: Awaited<ReturnType<typeof runAgentLoop>>;
      try {
        agentResult = await runAgentLoop(
          query,
          existingHistory,
          guildId,
          client as Client<true>,
          {
            threadContext: threadContext || undefined,
            currentChannelId: thread.id,
            emojiMap: guildConfig.emojiMap,
            mentionedUsers: mentionedUsers.size ? mentionedUsers : undefined,
            botId: client.user!.id,
            botUsername: client.user!.username,
            triggeringUser,
            currentChannel,
            serverContext,
            memoryIndex,
            memoryCount,
            memoryLimit: MEMORY_LIMIT,
            onInterimText: async (text) => {
              const expanded = expandMessageLinks(text, guildId);
              const componentMsgs = buildComponentMessages(expanded);
              for (const msgOpts of componentMsgs) {
                await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
              }
              await thread.sendTyping();
            },
          },
          thread.id,
        );
      } finally {
        clearInterval(typingInterval);
      }

      const { response, updatedHistory, pendingQuestion } = agentResult;

      if (pendingQuestion) {
        // Save state and send question+buttons — loop resumes on button click
        saveConversation(thread.id, guildId, updatedHistory, threadContext || null);
        pendingChoices.set(thread.id, { question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId: message.author.id });
        savePendingQuestion({ threadId: thread.id, question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId: message.author.id, createdAt: Date.now() });
        await sendQuestionWithButtons(thread, pendingQuestion.question, pendingQuestion.choices);
      } else {
        const expanded = expandMessageLinks(response, guildId);
        const componentMsgs = buildComponentMessages(expanded);
        appendFeedbackButtons(componentMsgs, thread.id);
        for (const msgOpts of componentMsgs) {
          await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
        }

        saveConversation(thread.id, guildId, updatedHistory, threadContext || null);

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
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : errMsg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      logger.error({ err }, "Error handling mention");
      try {
        await message.reply("An error occurred while processing your request. Check the logs.");
      } catch {
        // Ignore reply errors
      }
    } finally {
      span.end();
    }
  });
  }); // end withThreadLock
});

client.on(Events.MessageUpdate, (_old, newMsg) => {
  if (!newMsg.guildId) return;
  if (newMsg.partial) return;

  updateMessageContent(newMsg.id, buildMessageContent(newMsg), newMsg.editedTimestamp ?? Date.now());
});

client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;
  softDeleteMessage(message.id);
});

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag }, "Logged in");
  logger.info({ guilds: Object.keys(config.guildConfig) }, "Watching guilds");
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle feedback modal submissions
  if (interaction.isModalSubmit() && interaction.customId.startsWith(FEEDBACK_MODAL_PREFIX)) {
    await handleFeedbackModal(interaction as ModalSubmitInteraction);
    return;
  }

  if (!interaction.isButton()) return;

  // Handle feedback thumbs up/down button clicks
  if (interaction.customId.startsWith(FEEDBACK_BTN_PREFIX)) {
    await handleFeedbackButton(interaction as ButtonInteraction);
    return;
  }

  if (interaction.customId.startsWith(SCAN_BTN_PREFIX)) {
    const rest = interaction.customId.slice(SCAN_BTN_PREFIX.length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) return;
    const guildId = rest.slice(0, colonIdx);
    const choice = rest.slice(colonIdx + 1); // "yes" | "no"

    const pending = pendingScans.get(guildId);
    if (!pending) {
      await interaction.reply({ content: "Scan approval expired — please re-trigger the bot.", flags: MessageFlags.Ephemeral });
      return;
    }

    pendingScans.delete(guildId);
    await interaction.deferUpdate();
    await disableScanButtons(interaction as ButtonInteraction, choice === "yes" ? "Scan server" : "Skip");

    const guildConfig = config.guildConfig[guildId];
    if (!guildConfig) return;

    await withThreadLock(pending.threadId, async () => {
      const threadChannel = await client.channels.fetch(pending.threadId);
      if (!threadChannel?.isThread()) return;

      if (choice === "yes") {
        // Run scan agent loop first (fresh history, no user query)
        await threadChannel.sendTyping();
        const scanTypingInterval = setInterval(() => threadChannel.sendTyping(), 8000);
        const scanQuery = "[System: Perform initial server scan. Use listGuildChannels, listGuildRoles, and getRecentActivity to gather information about this server's structure and recent activity. Then call updateServerContext with a concise summary covering channels, roles, and any notable patterns. This is a background initialization task — do not address the user directly.]";
        try {
          const scanResult = await runAgentLoop(
            scanQuery,
            [],
            guildId,
            client as Client<true>,
            {
              currentChannelId: pending.threadId,
              emojiMap: guildConfig.emojiMap,
              botId: client.user!.id,
              botUsername: client.user!.username,
              triggeringUser: pending.triggeringUser,
              currentChannel: pending.currentChannel,
              serverContext: null,
              memoryIndex: [],
              memoryCount: 0,
              memoryLimit: MEMORY_LIMIT,
            },
            pending.threadId,
          );
          if (scanResult.response) {
            const expanded = expandMessageLinks(scanResult.response, guildId);
            const componentMsgs = buildComponentMessages(expanded);
            for (const msgOpts of componentMsgs) {
              await threadChannel.send({ ...msgOpts, allowedMentions: { parse: [] } });
            }
          }
        } finally {
          clearInterval(scanTypingInterval);
        }
      }

      // Run original user query with fresh history and updated server context
      const freshServerContext = getServerContext(guildId);
      const freshMemoryIndex = listMemoryTitles(guildId);
      const freshMemoryCount = getMemoryCount(guildId);

      await threadChannel.sendTyping();
      const typingInterval = setInterval(() => threadChannel.sendTyping(), 8000);

      try {
        const agentResult = await runAgentLoop(
          pending.query,
          [],
          guildId,
          client as Client<true>,
          {
            threadContext: pending.threadContext || undefined,
            currentChannelId: pending.threadId,
            emojiMap: guildConfig.emojiMap,
            mentionedUsers: pending.mentionedUsers,
            botId: client.user!.id,
            botUsername: client.user!.username,
            triggeringUser: pending.triggeringUser,
            currentChannel: pending.currentChannel,
            serverContext: freshServerContext,
            memoryIndex: freshMemoryIndex,
            memoryCount: freshMemoryCount,
            memoryLimit: MEMORY_LIMIT,
            onInterimText: async (text) => {
              const expanded = expandMessageLinks(text, guildId);
              const componentMsgs = buildComponentMessages(expanded);
              for (const msgOpts of componentMsgs) {
                await threadChannel.send({ ...msgOpts, allowedMentions: { parse: [] } });
              }
              await threadChannel.sendTyping();
            },
          },
          pending.threadId,
        );

        const { response, updatedHistory, pendingQuestion } = agentResult;
        if (pendingQuestion) {
          saveConversation(pending.threadId, guildId, updatedHistory, pending.threadContext || null);
          pendingChoices.set(pending.threadId, { question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId: pending.triggeringUser?.id ?? interaction.user.id });
          savePendingQuestion({ threadId: pending.threadId, question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId: pending.triggeringUser?.id ?? interaction.user.id, createdAt: Date.now() });
          await sendQuestionWithButtons(threadChannel, pendingQuestion.question, pendingQuestion.choices);
        } else {
          const expanded = expandMessageLinks(response, guildId);
          const componentMsgs = buildComponentMessages(expanded);
          for (const msgOpts of componentMsgs) {
            await threadChannel.send({ ...msgOpts, allowedMentions: { parse: [] } });
          }
          saveConversation(pending.threadId, guildId, updatedHistory, pending.threadContext || null);
        }
      } finally {
        clearInterval(typingInterval);
      }
    });
    return;
  }

  if (!interaction.customId.startsWith(ASK_BTN_PREFIX)) return;

  const parts = interaction.customId.slice(ASK_BTN_PREFIX.length).split(":");
  if (parts.length !== 2) return;
  const [threadId, indexStr] = parts;
  const choiceIndex = parseInt(indexStr, 10);

  const pending = pendingChoices.get(threadId);
  if (!pending || isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= pending.choices.length) {
    await interaction.reply({ content: "This question has expired — the bot was restarted. Please re-ask your query.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== pending.triggeredByUserId) {
    await interaction.reply({
      content: `Only <@${pending.triggeredByUserId}> can respond to this question.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const choice = pending.choices[choiceIndex];
  pendingChoices.delete(threadId);
  deletePendingQuestion(threadId);

  // Acknowledge and update the button message to show the selection
  await interaction.deferUpdate();
  await disableQuestionButtons(interaction as ButtonInteraction, pending.question, choice);

  try {
    await withThreadLock(threadId, async () => {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.isThread()) return;

    const guildId = thread.guildId;
    const guildConfig = config.guildConfig[guildId];
    if (!guildConfig) return;

    await thread.sendTyping();
    const typingInterval = setInterval(() => thread.sendTyping(), 8000);

    try {
      const { messages: existingHistory, initialThreadContext } = loadConversation(threadId);
      const serverContext = getServerContext(guildId);
      const memoryIndex = listMemoryTitles(guildId);
      const memoryCount = getMemoryCount(guildId);

      // Build triggeringUser from the button clicker
      const member = await thread.guild.members.fetch(interaction.user.id).catch(() => null);
      const memberRoles = member
        ? [...member.roles.cache.values()]
            .filter((r) => r.id !== thread.guild.roles.everyone.id)
            .sort((a, b) => b.position - a.position)
            .map((r) => ({ id: r.id, name: r.name }))
        : [];
      const isModerator = member?.roles.cache.hasAny(...guildConfig.allowedRoles) ?? false;
      const triggeringUser = {
        id: interaction.user.id,
        username: interaction.user.username,
        displayName: member?.displayName !== interaction.user.username ? member?.displayName ?? null : null,
        roles: memberRoles,
        isModerator,
      };

      // Build currentChannel from the thread
      const isPrivate = thread.type === ChannelType.PrivateThread;
      const currentChannel = {
        id: thread.id,
        name: thread.name,
        type: isPrivate ? "thread (private)" : "thread (public)",
        isPrivate,
        parentChannelId: thread.parentId ?? undefined,
        parentChannelName: thread.parent?.name ?? undefined,
      };

      const query = `[Selected: "${choice}"]`;

      const agentResult: AgentLoopResult = await runAgentLoop(
        query,
        existingHistory,
        guildId,
        client as Client<true>,
        {
          threadContext: initialThreadContext ?? undefined,
          currentChannelId: threadId,
          emojiMap: guildConfig.emojiMap,
          botId: client.user!.id,
          botUsername: client.user!.username,
          triggeringUser,
          currentChannel,
          serverContext,
          memoryIndex,
          memoryCount,
          memoryLimit: MEMORY_LIMIT,
          onInterimText: async (text) => {
            const expanded = expandMessageLinks(text, guildId);
            const componentMsgs = buildComponentMessages(expanded);
            for (const msgOpts of componentMsgs) {
              await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
            }
            await thread.sendTyping();
          },
        },
        threadId,
      );

      const { response, updatedHistory, pendingQuestion } = agentResult;

      if (pendingQuestion) {
        saveConversation(threadId, guildId, updatedHistory, initialThreadContext);
        pendingChoices.set(threadId, { question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId: interaction.user.id });
        savePendingQuestion({ threadId, question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId: interaction.user.id, createdAt: Date.now() });
        await sendQuestionWithButtons(thread, pendingQuestion.question, pendingQuestion.choices);
      } else {
        const expanded = expandMessageLinks(response, guildId);
        const componentMsgs = buildComponentMessages(expanded);
        appendFeedbackButtons(componentMsgs, threadId);
        for (const msgOpts of componentMsgs) {
          await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
        }
        saveConversation(threadId, guildId, updatedHistory, initialThreadContext);
      }
    } catch (err) {
      logger.error({ err }, "Error handling button interaction");
      await thread.send("An error occurred while processing your response. Check the logs.").catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  }); // end withThreadLock
  } catch (err) {
    logger.error({ err }, "Unexpected error in button interaction handler");
  }
});

async function sendScanApprovalMessage(thread: ThreadChannel, guildId: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SCAN_BTN_PREFIX}${guildId}:yes`)
      .setLabel("Scan server")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${SCAN_BTN_PREFIX}${guildId}:no`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: "No server context found. Would you like me to scan the server first (channels, roles, recent activity) before handling your request?" }))
    .addActionRowComponents(row);

  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

async function disableScanButtons(interaction: ButtonInteraction, selectedLabel: string): Promise<void> {
  try {
    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder({ content: `-# Selected: ${selectedLabel}` }));
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical
  }
}

async function sendQuestionWithButtons(
  thread: ThreadChannel,
  question: string,
  choices: string[],
): Promise<void> {
  const threadId = thread.id;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    choices.map((label, i) => {
      const safeLabel = label.length > 80 ? label.slice(0, 77) + "..." : label;
      return new ButtonBuilder()
        .setCustomId(`${ASK_BTN_PREFIX}${threadId}:${i}`)
        .setLabel(safeLabel)
        .setStyle(ButtonStyle.Primary);
    }),
  );

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: question }))
    .addActionRowComponents(row);

  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

async function disableQuestionButtons(
  interaction: ButtonInteraction,
  question: string,
  selectedLabel: string,
): Promise<void> {
  try {
    const container = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder({ content: `${question}\n-# Selected: ${selectedLabel}` }),
      );
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical — if we can't update the message, just continue
  }
}

function appendFeedbackButtons(componentMsgs: MessageCreateOptions[], threadId: string): void {
  if (componentMsgs.length === 0) return;
  const lastMsg = componentMsgs[componentMsgs.length - 1];
  const container = lastMsg.components?.[0] as ContainerBuilder | undefined;
  if (!container) return;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FEEDBACK_BTN_PREFIX}${threadId}:up`)
      .setLabel("👍 Helpful")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${FEEDBACK_BTN_PREFIX}${threadId}:down`)
      .setLabel("👎 Not Helpful")
      .setStyle(ButtonStyle.Secondary),
  );

  container
    .addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }))
    .addActionRowComponents(row);
}

async function handleFeedbackButton(interaction: ButtonInteraction): Promise<void> {
  // Custom ID format: fb:{threadId}:{up|down}
  const rest = interaction.customId.slice(FEEDBACK_BTN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return;
  const threadId = rest.slice(0, lastColon);
  const sentiment = rest.slice(lastColon + 1); // "up" | "down"

  const modal = new ModalBuilder()
    .setCustomId(`${FEEDBACK_MODAL_PREFIX}${threadId}:${sentiment}:${interaction.message.id}`)
    .setTitle(sentiment === "up" ? "What was helpful?" : "What could be improved?");

  const textInput = new TextInputBuilder()
    .setCustomId("fb_text")
    .setLabel("Your feedback (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleFeedbackModal(interaction: ModalSubmitInteraction): Promise<void> {
  // Custom ID format: fbm:{threadId}:{sentiment}:{buttonMsgId}
  const rest = interaction.customId.slice(FEEDBACK_MODAL_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length < 3) return;
  const [threadId, sentiment, buttonMsgId] = parts;

  const feedbackText = interaction.fields.getTextInputValue("fb_text") ?? "";

  // Acknowledge the modal immediately
  await interaction.reply({ content: "Thanks for the feedback!", flags: MessageFlags.Ephemeral });

  // Load conversation and save feedback file
  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.isThread()) return;

    const guildId = thread.guildId;
    const { messages: conversation } = loadConversation(threadId);

    await saveFeedback({
      threadId,
      guildId,
      userId: interaction.user.id,
      username: interaction.user.username,
      sentiment: sentiment === "up" ? "positive" : "negative",
      feedback: feedbackText,
      timestamp: new Date().toISOString(),
      conversation,
    });

    // Update the feedback button message to show it was recorded
    try {
      const btnMsg = await thread.messages.fetch(buttonMsgId);
      const label = sentiment === "up" ? "👍 Helpful" : "👎 Not Helpful";
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder({ content: `-# ${label} — feedback recorded, thank you!` }),
      );
      await btnMsg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch {
      // Non-critical — button message may no longer be editable
    }
  } catch (err) {
    logger.error({ err }, "Error saving feedback");
  }
}

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

function getChannelContext(message: Message): ChannelContext {
  const ch = message.channel;

  if (ch.isThread()) {
    const isPrivate = ch.type === ChannelType.PrivateThread;
    return {
      id: ch.id,
      name: ch.name,
      type: isPrivate ? "thread (private)" : "thread (public)",
      isPrivate,
      parentChannelId: ch.parentId ?? undefined,
      parentChannelName: ch.parent?.name ?? undefined,
      categoryName: (ch.parent as { parent?: { name?: string } } | null)?.parent?.name ?? undefined,
    };
  }

  const everyoneId = message.guild?.roles.everyone.id;
  const isPrivate = everyoneId ? isPrivateChannel(ch as Parameters<typeof isPrivateChannel>[0], everyoneId) : false;

  let type = "text";
  if (ch.type === ChannelType.GuildAnnouncement) type = "announcement";
  else if (ch.type === ChannelType.GuildVoice) type = "voice";

  const name = "name" in ch ? (ch.name ?? "(unknown)") : "(unknown)";
  const topic = "topic" in ch && ch.topic ? ch.topic : undefined;
  const parent = "parent" in ch ? ch.parent : null;
  const categoryName = parent && "type" in parent && parent.type === ChannelType.GuildCategory ? parent.name : undefined;

  return { id: ch.id, name, type, isPrivate, topic, categoryName };
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
  const botSuffix = m.author.bot ? " [bot]" : "";
  const content = buildMessageContent(m);
  return `t:${ts}:R u:${m.author.id} (${m.author.username}${botSuffix}): ${content}`;
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

  // Track inner components separately so we can drop trailing separators cleanly
  type Inner = TextDisplayBuilder | SeparatorBuilder;
  let inner: Inner[] = [];
  let charCount = 0;

  const flush = () => {
    // Drop trailing separators
    while (inner.length > 0 && inner[inner.length - 1] instanceof SeparatorBuilder) inner.pop();
    if (inner.length === 0) return;

    const container = new ContainerBuilder();
    for (const c of inner) {
      if (c instanceof TextDisplayBuilder) container.addTextDisplayComponents(c);
      else container.addSeparatorComponents(c as SeparatorBuilder);
    }
    messages.push({ components: [container], flags: MessageFlags.IsComponentsV2 });
    inner = [];
    charCount = 0;
  };

  for (const el of elements) {
    if (el.kind === "separator") {
      if (inner.length === 0) continue; // skip leading separator in a new container
      if (inner.length >= MAX_COMPONENTS - 1) { flush(); continue; }
      inner.push(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
    } else {
      // Flush if adding this element would exceed total displayable text limit or component count
      if (charCount + el.content.length > TEXT_DISPLAY_MAX || inner.length >= MAX_COMPONENTS) flush();
      inner.push(new TextDisplayBuilder({ content: el.content }));
      charCount += el.content.length;
    }
  }

  flush();
  return messages;
}

export async function startBot(): Promise<void> {
  // Run cleanup on startup, then daily
  deleteOldMessages();
  setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);

  deleteStaleConversations(90 * 24 * 60 * 60 * 1000); // 90-day TTL
  setInterval(() => deleteStaleConversations(90 * 24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);

  // Delete stale pending questions (older than 24h) before restoring, then schedule hourly cleanup
  deleteStalePendingQuestions(24 * 60 * 60 * 1000);
  // Restore pending questions from DB so buttons remain functional after restart
  for (const pq of loadAllPendingQuestions()) {
    pendingChoices.set(pq.threadId, { question: pq.question, choices: pq.choices, triggeredByUserId: pq.triggeredByUserId });
  }
  // Hourly: prune stale questions from DB and re-sync the in-memory map
  setInterval(() => {
    deleteStalePendingQuestions(24 * 60 * 60 * 1000);
    const fresh = new Map<string, PendingQuestionState>();
    for (const pq of loadAllPendingQuestions()) {
      fresh.set(pq.threadId, { question: pq.question, choices: pq.choices, triggeredByUserId: pq.triggeredByUserId });
    }
    // Remove stale entries
    for (const key of [...pendingChoices.keys()]) {
      if (!fresh.has(key)) pendingChoices.delete(key);
    }
    // Add/update new entries
    for (const [key, val] of fresh) {
      pendingChoices.set(key, val);
    }
  }, 60 * 60 * 1000);

  await client.login(config.discordBotToken);
}
