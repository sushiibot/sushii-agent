import {
  ActionRowBuilder,
  ChannelType,
  Client,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Message,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from "discord.js";
import { client } from "./discordClient.ts";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { buildMessageContent } from "./utils/flattenMessage.ts";
import { config, buildEmojiMap, resolvedModules } from "./config.ts";
import { getLogger } from "./logger.ts";
import {
  insertMessage,
  updateMessageContent,
  softDeleteMessage,
  deleteOldMessages,
} from "./db/messages.ts";
import { loadConversation, saveConversation, deleteStaleConversations } from "./db/conversations.ts";
import { registerWikiSyncCommands, handleWikiSyncCommand, WIKI_SYNC_COMMAND_NAME, startWikiSyncScheduler } from "./modules/wiki-sync/index.ts";
import { runAgentLoop, buildSystemPrompt, type UserNames, type ChannelContext, type TriggeringUser, type AgentLoopResult } from "./agent/loop.ts";
import {
  ToolProgressTracker,
  threadLocks,
  withThreadLock,
  cleanupAgentRun,
  threadCancellations,
  threadTriggeringUsers,
  threadMidLoopQueues,
  buildLoopOptions,
  STOP_BTN_PREFIX,
  ASK_BTN_PREFIX,
  FEEDBACK_BTN_PREFIX,
  pendingChoices,
  setPendingQuestion,
  clearPendingQuestion,
  restorePendingQuestions,
  sendQuestionWithButtons,
  disableQuestionButtons,
  buildComponentMessages,
  appendFeedbackButtons,
  type MidLoopMessage,
} from "./agent/delivery.ts";
import { saveFeedback } from "./feedback.ts";
import { getServerContext, listMemoryTitles, getMemoryCount } from "./db/memory.ts";
import { populateMcpToolEntries } from "./modules/registry.ts";
import { mcpClient } from "./modules/moderation/executor.ts";
import { BEHAVIOR_INSTRUCTIONS } from "./modules/moderation/prompt.ts";
import { pendingScans, pendingAutomodApprovals, pendingAutomodDeletions } from "./modules/moderation/state.ts";
import {
  SCAN_BTN_PREFIX,
  AUTOMOD_BTN_PREFIX,
  AUTOMOD_DEL_BTN_PREFIX,
  sendScanApprovalMessage,
  sendAutomodApprovalMessage,
  sendAutomodDeletionMessage,
  handleAutomodApprovalButton,
  handleAutomodDeletionButton,
  handleScanButton,
} from "./modules/moderation/interactions.ts";
import {
  isAutoModEligible,
  checkAndSetAutoModCooldown,
  handleAutoModTrigger,
} from "./modules/moderation/dispatch.ts";
import { resolveOrCreateThread, renameThread } from "./threads/manager.ts";
import { isPrivateChannel } from "./tools/channelUtils.ts";

const logger = getLogger("bot");
const tracer = trace.getTracer("sushii-agent");

// Wraps a Discord interaction handler in a span, recording exceptions and
// re-throwing so callers keep their existing error handling — mirrors the
// discord.message span below.
function withInteractionSpan<T>(
  name: string,
  attributes: Record<string, string | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : errMsg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Custom ID prefix for feedback modal submissions: fbm:{threadId}:{sentiment}
const FEEDBACK_MODAL_PREFIX = "fbm:";

client.on(Events.MessageCreate, async (message: Message) => {
  if (!message.guildId) return;

  const guildConfig = config.guildConfig[message.guildId];
  if (!guildConfig) return;

  const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

  // Cache every message from configured guilds, including bots (modmail, logs, etc.)
  insertMessage(message);

  // Don't trigger the agent on bot messages
  if (message.author.bot) return;

  // Everything below is moderation-specific — skip entirely for guilds that
  // haven't opted into the moderation module (e.g. wiki-sync-only guilds).
  if (!resolvedModules(guildConfig).includes("moderation")) return;

  // Auto-mod trigger: mod role pinged by an authorized role (doesn't require bot mention)
  if (isAutoModEligible(message, guildConfig)) {
    if (!checkAndSetAutoModCooldown(message.guildId, message.channelId, guildConfig)) {
      logger.debug({ guildId: message.guildId, channelId: message.channelId }, "auto-mod trigger suppressed by cooldown");
      return;
    }

    void handleAutoModTrigger(message, message.guildId, guildConfig, emojiMap, handleAgentResult);
    return;
  }

  // Respond to mentions or direct replies to the bot's messages
  const isMention = message.mentions.has(client.user!.id);
  const isReply = !isMention && (await isReplyToBot(message, client.user!.id));
  if (!isMention && !isReply) return;

  // Whitelist checks
  if (!message.member?.roles.cache.hasAny(...guildConfig.allowedRoles)) return;

  // Only strip the bot's own mention, preserve other user/channel mentions for the agent
  const botMentionRe = new RegExp(`<@!?${client.user!.id}>`, "g");
  const rawQuery = message.content.replace(botMentionRe, "").trim();
  // A ping with no text is a request to look at what's going on, not a no-op
  const isBarePing = rawQuery.length === 0;

  // Replace custom Discord emojis in query using the emoji map
  const emojiQuery = rawQuery.replace(/<a?:(\w+):\d+>/g, (match, name) => emojiMap[name] ?? match);

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
  let body: string;
  if (!isBarePing) {
    body = normalizedQuery;
  } else {
    // A text-less ping can still carry attachments, embeds or a forwarded message
    const flattened = buildMessageContent(message).replace(botMentionRe, "").trim();
    const attached = flattened && flattened !== "[empty message]" ? `${flattened}\n` : "";
    body = `${attached}[No message text — review the recent activity shown in your context, investigate anything unclear or needing moderator attention, and summarize what's going on. If nothing needs attention, say so briefly.]`;
  }
  const query = `${replyContext}[Message from ${message.author.username} (<@${message.author.id}>)]\n${body}`;

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

  // If an agent loop is already running for this thread, queue the message for mid-loop injection
  // rather than waiting for the current loop to finish and starting a fresh one.
  let midLoopMsg: MidLoopMessage | null = null;
  if (threadLocks.has(message.channelId)) {
    midLoopMsg = { query, mentionedUsers, discordMessage: message, consumed: false };
    const q = threadMidLoopQueues.get(message.channelId) ?? [];
    q.push(midLoopMsg);
    threadMidLoopQueues.set(message.channelId, q);
    logger.info({ channelId: message.channelId }, "queued message for mid-loop injection");
    message.react("⏳").catch(() => {});
  }

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
      // If this message was queued for mid-loop injection and was already consumed, skip.
      if (midLoopMsg?.consumed) {
        logger.info({ channelId: message.channelId }, "mid-loop message consumed by running loop, skipping fallback run");
        return;
      }

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

      // threadContext is frozen after the first turn for prompt-cache stability, so new
      // thread activity is appended to the query instead — keeps the prefix byte-identical.
      // Skipped when the context was just re-fetched live (pre-existing threads with no stored
      // snapshot), since that already covers the same messages.
      let turnQuery = query;
      if (existingHistory.length > 0 && initialThreadContext != null) {
        const excludeIds = new Set<string>([message.id]);
        for (const queued of threadMidLoopQueues.get(thread.id) ?? []) {
          excludeIds.add(queued.discordMessage.id);
        }
        const interstitial = await fetchInterstitialMessages(thread, client.user!.id, excludeIds);
        if (interstitial) {
          turnQuery = `[Thread activity since your last response]\n${interstitial}\n\n${query}`;
          logger.child({ threadId: thread.id }).debug(
            { lineCount: interstitial.split("\n").length, interstitial },
            "injected thread activity since last response",
          );
        }
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

      const toolTracker = new ToolProgressTracker(thread);

      // Clear any stale cancellation from a previous run
      threadCancellations.delete(thread.id);
      threadTriggeringUsers.set(thread.id, message.author.id);

      let agentResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
      try {
        agentResult = await runAgentLoop(
          turnQuery,
          existingHistory,
          guildId,
          client as Client<true>,
          resolvedModules(config.guildConfig[guildId] ?? { allowedRoles: [] }),
          BEHAVIOR_INSTRUCTIONS,
          buildLoopOptions(thread, guildId, emojiMap, toolTracker, {
            threadContext: threadContext || undefined,
            mentionedUsers: mentionedUsers.size ? mentionedUsers : undefined,
            triggeringUser,
            currentChannel,
            serverContext,
            memoryIndex,
            memoryCount,
          }),
        );
      } finally {
        await cleanupAgentRun(thread.id, typingInterval, toolTracker, agentResult);
      }

      if (!agentResult) return;
      await handleAgentResult(thread, guildId, thread.id, agentResult, threadContext, message.author.id);

      // Rename thread when there's enough context:
      // - 3+ tool uses on first turn (rich investigation), OR
      // - any tool use on a follow-up turn (user sent another message, so we have more context)
      if (!agentResult.cancelled && !agentResult.pendingQuestion && !agentResult.pendingAutomodApproval && !agentResult.pendingAutomodDeletion) {
        const toolUseCount = agentResult.updatedHistory.filter((m) => m.role === "tool").length;
        const userTurnCount = agentResult.updatedHistory.filter((m) => m.role === "user").length;
        const isDefaultName = thread.name === "sushii-agent investigation";
        const enoughContext = toolUseCount >= 3 || userTurnCount >= 2;
        if (toolUseCount > 0 && enoughContext && (isNew || isDefaultName)) {
          await renameThread(thread, agentResult.updatedHistory);
        }
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : errMsg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      logger.error({ err }, "Error handling mention");
      try {
        const traceId = span.spanContext().traceId;
        await message.reply(`An error occurred while processing your request.\n-# trace: ${traceId}`);
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

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Logged in");
  logger.info({ guilds: Object.keys(config.guildConfig) }, "Watching guilds");

  await registerWikiSyncCommands(c).catch((err) => logger.error({ err }, "failed to register wiki-sync commands"));
  startWikiSyncScheduler(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle feedback modal submissions
  if (interaction.isModalSubmit() && interaction.customId.startsWith(FEEDBACK_MODAL_PREFIX)) {
    await handleFeedbackModal(interaction as ModalSubmitInteraction);
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === WIKI_SYNC_COMMAND_NAME) {
    await handleWikiSyncCommand(interaction);
    return;
  }

  if (!interaction.isButton()) return;

  // Handle stop-loop button clicks
  if (interaction.customId.startsWith(STOP_BTN_PREFIX)) {
    const threadId = interaction.customId.slice(STOP_BTN_PREFIX.length);
    const triggeringUserId = threadTriggeringUsers.get(threadId);
    if (!triggeringUserId) {
      await (interaction as ButtonInteraction).reply({ content: "No active loop to stop.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== triggeringUserId) {
      await (interaction as ButtonInteraction).reply({ content: "Only the person who triggered this loop can stop it.", flags: MessageFlags.Ephemeral });
      return;
    }
    threadCancellations.add(threadId);
    await (interaction as ButtonInteraction).reply({ content: "Stopping...", flags: MessageFlags.Ephemeral });
    return;
  }

  // Handle feedback thumbs up/down button clicks
  if (interaction.customId.startsWith(FEEDBACK_BTN_PREFIX)) {
    await handleFeedbackButton(interaction as ButtonInteraction);
    return;
  }

  if (interaction.customId.startsWith(SCAN_BTN_PREFIX)) {
    await handleScanButton(interaction as ButtonInteraction, {
      buildLoopOptions,
      handleAgentResult,
      withInteractionSpan,
    });
    return;
  }

  // Handle automod keyword approval buttons: amka:{threadId}:{approve|reject}
  if (interaction.customId.startsWith(AUTOMOD_BTN_PREFIX)) {
    await handleAutomodApprovalButton(interaction as ButtonInteraction, resumeAgentAfterApproval);
    return;
  }

  // Handle automod keyword deletion approval buttons: amkd:{threadId}:{approve|reject}
  if (interaction.customId.startsWith(AUTOMOD_DEL_BTN_PREFIX)) {
    await handleAutomodDeletionButton(interaction as ButtonInteraction, resumeAgentAfterApproval);
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
  clearPendingQuestion(threadId);

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

      await withInteractionSpan("discord.interaction", {
        "discord.thread_id": threadId,
        "discord.guild_id": guildId,
        "discord.user_id": interaction.user.id,
        "discord.trigger": "ask_question_choice",
      }, async () => {
        const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

        await thread.sendTyping();
        const typingInterval = setInterval(() => thread.sendTyping(), 8000);
        const toolTracker = new ToolProgressTracker(thread);
        threadCancellations.delete(threadId);
        threadTriggeringUsers.set(threadId, interaction.user.id);

        let agentResult: AgentLoopResult | undefined;
        try {
          const { messages: existingHistory, initialThreadContext } = loadConversation(threadId);
          const serverContext = getServerContext(guildId);
          const memoryIndex = listMemoryTitles(guildId);
          const memoryCount = getMemoryCount(guildId);

          const { triggeringUser, currentChannel } = await buildInteractionContext(interaction as ButtonInteraction, thread, guildConfig);

          const query = `[Selected: "${choice}"]`;

          agentResult = await runAgentLoop(
            query,
            existingHistory,
            guildId,
            client as Client<true>,
            resolvedModules(guildConfig),
            BEHAVIOR_INSTRUCTIONS,
            buildLoopOptions(thread, guildId, emojiMap, toolTracker, {
              threadContext: initialThreadContext ?? undefined,
              triggeringUser,
              currentChannel,
              serverContext,
              memoryIndex,
              memoryCount,
            }),
          );
          await handleAgentResult(thread, guildId, threadId, agentResult, initialThreadContext ?? null, interaction.user.id);
        } catch (err) {
          logger.child({ threadId, guildId }).error({ err }, "Error handling button interaction");
          const traceId1 = trace.getActiveSpan()?.spanContext().traceId ?? "unknown";
          await thread.send(`An error occurred while processing your response.\n-# trace: ${traceId1}`).catch(() => {});
        } finally {
          await cleanupAgentRun(threadId, typingInterval, toolTracker, agentResult);
        }
      });
    }); // end withThreadLock
  } catch (err) {
    logger.error({ err }, "Unexpected error in button interaction handler");
  }
});

// Stays in bot.ts rather than delivery.ts: it calls both delivery-owned helpers
// (appendFeedbackButtons, buildComponentMessages) and moderation-owned
// sendAutomodApprovalMessage/sendAutomodDeletionMessage, which themselves need
// withThreadLock/resumeAgentAfterApproval — moving it would create a value-level
// import cycle between delivery.ts and moderation/interactions.ts.
async function handleAgentResult(
  thread: ThreadChannel,
  guildId: string,
  threadId: string,
  agentResult: AgentLoopResult,
  threadContext: string | null,
  triggeredByUserId: string,
): Promise<void> {
  const { response, updatedHistory, pendingQuestion, pendingAutomodApproval, pendingAutomodDeletion, cancelled } = agentResult;

  if (cancelled) {
    saveConversation(threadId, guildId, updatedHistory, threadContext);
    await thread.send({ content: "-# *(loop stopped)*", allowedMentions: { parse: [] } }).catch(() => {});
  } else if (pendingQuestion) {
    saveConversation(threadId, guildId, updatedHistory, threadContext);
    setPendingQuestion(threadId, { question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId });
    await sendQuestionWithButtons(thread, pendingQuestion.question, pendingQuestion.choices);
  } else if (pendingAutomodApproval) {
    saveConversation(threadId, guildId, updatedHistory, threadContext);
    pendingAutomodApprovals.set(threadId, { ...pendingAutomodApproval, triggeredByUserId });
    await sendAutomodApprovalMessage(thread, pendingAutomodApproval);
  } else if (pendingAutomodDeletion) {
    saveConversation(threadId, guildId, updatedHistory, threadContext);
    pendingAutomodDeletions.set(threadId, { ...pendingAutomodDeletion, triggeredByUserId });
    await sendAutomodDeletionMessage(thread, pendingAutomodDeletion);
  } else {
    const componentMsgs = buildComponentMessages(response);
    appendFeedbackButtons(componentMsgs, threadId);
    logger.child({ threadId, guildId }).debug(
      { messageCount: componentMsgs.length, content: response },
      "discord response sent",
    );
    for (const msgOpts of componentMsgs) {
      await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
    }
    saveConversation(threadId, guildId, updatedHistory, threadContext);
  }
}

async function buildInteractionContext(
  interaction: ButtonInteraction,
  thread: ThreadChannel,
  guildConfig: { allowedRoles: string[] },
): Promise<{ triggeringUser: TriggeringUser; currentChannel: ChannelContext }> {
  const member = await thread.guild.members.fetch(interaction.user.id).catch(() => null);
  const memberRoles = member
    ? [...member.roles.cache.values()]
        .filter((r) => r.id !== thread.guild.roles.everyone.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name }))
    : [];
  const isModerator = member?.roles.cache.hasAny(...guildConfig.allowedRoles) ?? false;
  const triggeringUser: TriggeringUser = {
    id: interaction.user.id,
    username: interaction.user.username,
    displayName: member?.displayName !== interaction.user.username ? member?.displayName ?? null : null,
    roles: memberRoles,
    isModerator,
  };
  const isPrivate = thread.type === ChannelType.PrivateThread;
  const currentChannel: ChannelContext = {
    id: thread.id,
    name: thread.name,
    type: isPrivate ? "thread (private)" : "thread (public)",
    isPrivate,
    parentChannelId: thread.parentId ?? undefined,
    parentChannelName: thread.parent?.name ?? undefined,
  };
  return { triggeringUser, currentChannel };
}

// Stays in bot.ts, not delivery.ts: it calls handleAgentResult, which is itself
// pinned to bot.ts to avoid a delivery.ts <-> moderation/interactions.ts import
// cycle (see the comment on handleAgentResult above) — moving this function alone
// would just relocate the same cycle.
async function resumeAgentAfterApproval(
  interaction: ButtonInteraction,
  threadId: string,
  systemMessage: string,
): Promise<void> {
  await withThreadLock(threadId, async () => {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.isThread()) return;

    const guildId = thread.guildId;
    const guildConfig = config.guildConfig[guildId];
    if (!guildConfig) return;

    await withInteractionSpan("discord.interaction", {
      "discord.thread_id": threadId,
      "discord.guild_id": guildId,
      "discord.user_id": interaction.user.id,
      "discord.trigger": "approval_resume",
    }, async () => {
      const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);
      const { messages: existingHistory, initialThreadContext } = loadConversation(threadId);
      const serverContext = getServerContext(guildId);
      const memoryIndex = listMemoryTitles(guildId);
      const memoryCount = getMemoryCount(guildId);

      const { triggeringUser, currentChannel } = await buildInteractionContext(interaction, thread, guildConfig);

      await thread.sendTyping();
      const typingInterval = setInterval(() => thread.sendTyping(), 8000);
      const toolTracker = new ToolProgressTracker(thread);
      threadCancellations.delete(threadId);
      threadTriggeringUsers.set(threadId, interaction.user.id);

      let agentResult: AgentLoopResult | undefined;
      try {
        agentResult = await runAgentLoop(
          systemMessage,
          existingHistory,
          guildId,
          client as Client<true>,
          resolvedModules(guildConfig),
          BEHAVIOR_INSTRUCTIONS,
          buildLoopOptions(thread, guildId, emojiMap, toolTracker, {
            threadContext: initialThreadContext ?? undefined,
            triggeringUser,
            currentChannel,
            serverContext,
            memoryIndex,
            memoryCount,
          }),
        );
        await handleAgentResult(thread, guildId, threadId, agentResult, initialThreadContext ?? null, interaction.user.id);
      } catch (err) {
        logger.child({ threadId, guildId }).error({ err }, "Error resuming loop after approval");
        const traceId2 = trace.getActiveSpan()?.spanContext().traceId ?? "unknown";
        await thread.send(`An error occurred while processing the approval.\n-# trace: ${traceId2}`).catch(() => {});
      } finally {
        await cleanupAgentRun(threadId, typingInterval, toolTracker, agentResult);
      }
    });
  });
}

async function handleFeedbackButton(interaction: ButtonInteraction): Promise<void> {
  // Custom ID format: fb:{threadId}:{up|down}
  const rest = interaction.customId.slice(FEEDBACK_BTN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return;
  const threadId = rest.slice(0, lastColon);
  const sentiment = rest.slice(lastColon + 1); // "up" | "down"

  const modal = new ModalBuilder()
    .setCustomId(`${FEEDBACK_MODAL_PREFIX}${threadId}:${sentiment}`)
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
  // Custom ID format: fbm:{threadId}:{sentiment}
  const rest = interaction.customId.slice(FEEDBACK_MODAL_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length < 2) return;
  const [threadId, sentiment] = parts;

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

// Budget for the injected thread-activity block, in characters
const INTERSTITIAL_MAX_CHARS = 8000;

/**
 * Thread messages posted after the bot's most recent message — conversation between
 * moderators that happened between agent turns and so isn't in the stored history.
 *
 * Anchoring on the bot's last message instead of a stored watermark means messages
 * already injected mid-loop are excluded for free: the loop's reply lands after them.
 */
async function fetchInterstitialMessages(
  thread: ThreadChannel,
  botId: string,
  excludeIds: Set<string>,
  limit = 100,
): Promise<string> {
  const fetched = await thread.messages.fetch({ limit });
  const ordered = [...fetched.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );

  let lastBotIdx = -1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].author.id === botId) {
      lastBotIdx = i;
      break;
    }
  }
  if (lastBotIdx === -1) {
    // Bot silent for the whole window, so nothing in it can already be in history —
    // take it all rather than degrading to no context in the busiest threads.
    logger.warn(
      { threadId: thread.id, limit },
      "no bot message within interstitial window, using full window",
    );
  }

  const since = ordered
    .slice(lastBotIdx + 1)
    .filter((m) => m.author.id !== botId && !excludeIds.has(m.id));

  // Keep the most recent lines within budget — a single burst of long messages
  // would otherwise dwarf the actual conversation history
  const lines = since.map(formatMessageLine);
  let used = 0;
  let startIdx = lines.length;
  while (startIdx > 0 && used + lines[startIdx - 1].length + 1 <= INTERSTITIAL_MAX_CHARS) {
    startIdx--;
    used += lines[startIdx].length + 1;
  }
  // A single over-budget message would otherwise leave nothing at all
  if (startIdx === lines.length && lines.length > 0) {
    startIdx = lines.length - 1;
    lines[startIdx] = lines[startIdx].slice(0, INTERSTITIAL_MAX_CHARS);
  }

  const kept = lines.slice(startIdx);
  if (startIdx > 0) {
    kept.unshift(`[${startIdx} older message(s) omitted]`);
  }

  return kept.join("\n");
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

export async function startBot(): Promise<void> {
  // Run cleanup on startup, then daily
  deleteOldMessages();
  setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);

  deleteStaleConversations(90 * 24 * 60 * 60 * 1000); // 90-day TTL
  setInterval(() => deleteStaleConversations(90 * 24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);

  // Restore pending questions from DB so buttons remain functional after restart,
  // then schedule an hourly prune + re-sync of the in-memory map.
  restorePendingQuestions();
  setInterval(restorePendingQuestions, 60 * 60 * 1000);

  if (mcpClient) {
    try {
      const mcpTools = await mcpClient.getTools();
      populateMcpToolEntries(mcpTools);
      logger.info({ count: mcpTools.length }, "loaded MCP tools from server");
    } catch (err) {
      logger.warn({ err }, "failed to load MCP tools from server — continuing without them");
    }
  }

  await client.login(config.discordBotToken);
}
