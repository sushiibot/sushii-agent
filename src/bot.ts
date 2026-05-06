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
import { config, buildEmojiMap } from "./config.ts";
import { getLogger } from "./logger.ts";
import {
  insertMessage,
  updateMessageContent,
  softDeleteMessage,
  deleteOldMessages,
} from "./db/messages.ts";
import { loadConversation, saveConversation, deleteStaleConversations } from "./db/conversations.ts";
import { savePendingQuestion, deletePendingQuestion, loadAllPendingQuestions, deleteStalePendingQuestions } from "./db/pendingQuestions.ts";
import { runAgentLoop, expandMessageLinks, buildSystemPrompt, formatToolArg, type UserNames, type ChannelContext, type TriggeringUser, type AgentLoopResult, type AgentLoopOptions, type PendingAutomodApproval, type PendingAutomodDeletion } from "./agent/loop.ts";
import { saveFeedback } from "./feedback.ts";
import { getServerContext, listMemoryTitles, getMemoryCount, MEMORY_LIMIT } from "./db/memory.ts";
import { TOOL_DEFINITIONS } from "./agent/tools.ts";
import { resolveOrCreateThread, renameThread } from "./threads/manager.ts";
import { isPrivateChannel } from "./tools/channelUtils.ts";

const logger = getLogger("bot");
const tracer = trace.getTracer("sushii-agent");

/**
 * Tracks tool calls during an agent loop iteration and displays them as a live
 * Discord message that gets edited in place. Multiple rapid calls are batched
 * together with a debounce so we don't hit rate limits.
 */
class ToolProgressTracker {
  private msg: Message | null = null;
  private lines: string[] = [];
  private lastContent = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_MS = 500;

  constructor(private thread: ThreadChannel) {}

  add(tools: { name: string; input: Record<string, unknown> }[]): void {
    for (const { name, input } of tools) {
      const args = Object.entries(input)
        .map(([k, v]) => `${k}=${formatToolArg(v)}`)
        .join(", ");
      this.lines.push(args ? `${name}(${args})` : name);
    }
    this.scheduleFlush();
  }

  private buildContent(): string {
    return this.lines.map((l) => `-# - ${l}`).join("\n").slice(0, 3990);
  }

  private cancelPendingFlush(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.lines.length > 0) {
      this.lastContent = this.buildContent();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flush(); }, ToolProgressTracker.DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    // Components V2 TextDisplay limit is 4000 chars per component
    this.lastContent = this.buildContent();
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${STOP_BTN_PREFIX}${this.thread.id}`)
        .setLabel("⬛ Stop")
        .setStyle(ButtonStyle.Danger),
    );
    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder({ content: this.lastContent }))
      .addActionRowComponents(stopRow);
    try {
      if (!this.msg) {
        this.msg = await this.thread.send({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      } else {
        await this.msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      logger.warn({ err }, "failed to update tool progress message");
    }
  }

  /**
   * Flush pending updates, remove the stop button, and reset state for the next batch.
   * Call this before sending interim text so new tool dispatches start a fresh message.
   */
  async reset(): Promise<void> {
    this.cancelPendingFlush();
    if (this.msg && this.lastContent) {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder({ content: this.lastContent }),
      );
      try {
        await this.msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      } catch (err) {
        logger.warn({ err }, "failed to reset tool progress message");
      }
    }
    this.msg = null;
    this.lines = [];
    this.lastContent = "";
  }

  /** Flush pending updates, then remove the stop button. If cancelled, append a note. */
  async finalize(cancelled = false): Promise<void> {
    // Update lastContent without sending (avoid double-edit flicker)
    this.cancelPendingFlush();
    if (!this.msg) return;
    if (!this.lastContent && !cancelled) return;

    let content: string;
    if (cancelled && this.lastContent) {
      content = `${this.lastContent}\n-# *(stopped)*`;
    } else if (cancelled) {
      content = `-# *(stopped)*`;
    } else {
      content = this.lastContent;
    }
    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder({ content }),
    );
    try {
      await this.msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (err) {
      logger.warn({ err }, "failed to finalize tool progress message");
    }
  }
}

// In-memory map of threadId → pending question state (restored from DB on startup)
interface PendingQuestionState {
  question: string;
  choices: string[];
  triggeredByUserId: string;
}
const pendingChoices = new Map<string, PendingQuestionState>();

// Per-channel async mutex to prevent concurrent agent runs in the same thread
const threadLocks = new Map<string, Promise<void>>();

// Mid-loop message injection: messages queued while an agent loop is already running
interface MidLoopMessage {
  query: string;
  mentionedUsers: Map<string, UserNames>;
  /** Original Discord message, kept for reaction updates. */
  discordMessage: Message;
  /** Set to true by the agent loop when it injects this message — skips the fallback withThreadLock run. */
  consumed: boolean;
}
const threadMidLoopQueues = new Map<string, MidLoopMessage[]>();
// Thread IDs where the user has requested the agent loop to stop
const threadCancellations = new Set<string>();
// Maps threadId → userId of the user who triggered the current agent loop
const threadTriggeringUsers = new Map<string, string>();

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
// Custom ID prefix for feedback modal submissions: fbm:{threadId}:{sentiment}
const FEEDBACK_MODAL_PREFIX = "fbm:";
// Custom ID prefix for stop-loop button: stop:{threadId}
const STOP_BTN_PREFIX = "stop:";
// Custom ID prefix for automod keyword add approval buttons: amka:{threadId}:{approve|reject}
const AUTOMOD_BTN_PREFIX = "amka:";
// Custom ID prefix for automod keyword delete approval buttons: amkd:{threadId}:{approve|reject}
const AUTOMOD_DEL_BTN_PREFIX = "amkd:";

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

interface PendingAutomodApprovalState extends PendingAutomodApproval {
  triggeredByUserId: string;
}

// Per-thread pending automod keyword approval state (in-memory only, cleared on approve/reject/restart)
const pendingAutomodApprovals = new Map<string, PendingAutomodApprovalState>();

interface PendingAutomodDeletionState extends PendingAutomodDeletion {
  triggeredByUserId: string;
}

// Per-thread pending automod keyword deletion state (in-memory only, cleared on approve/reject/restart)
const pendingAutomodDeletions = new Map<string, PendingAutomodDeletionState>();

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

  const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

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
        emojiMap: emojiMap,
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
          query,
          existingHistory,
          guildId,
          client as Client<true>,
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
      await handleAgentResult(thread, guildId, thread.id, agentResult, threadContext || null, message.author.id);

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

    const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

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
              emojiMap: emojiMap,
              botId: client.user!.id,
              botUsername: client.user!.username,
              triggeringUser: pending.triggeringUser,
              currentChannel: pending.currentChannel,
              serverContext: null,
              memoryIndex: [],
              memoryCount: 0,
              memoryLimit: MEMORY_LIMIT,
            },
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
      const toolTracker = new ToolProgressTracker(threadChannel);
      threadCancellations.delete(pending.threadId);
      threadTriggeringUsers.set(pending.threadId, pending.triggeringUser?.id ?? interaction.user.id);

      let agentResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
      try {
        agentResult = await runAgentLoop(
          pending.query,
          [],
          guildId,
          client as Client<true>,
          buildLoopOptions(threadChannel, guildId, emojiMap, toolTracker, {
            threadContext: pending.threadContext || undefined,
            mentionedUsers: pending.mentionedUsers,
            triggeringUser: pending.triggeringUser,
            currentChannel: pending.currentChannel,
            serverContext: freshServerContext,
            memoryIndex: freshMemoryIndex,
            memoryCount: freshMemoryCount,
          }),
        );

        await handleAgentResult(threadChannel, guildId, pending.threadId, agentResult, pending.threadContext || null, pending.triggeringUser?.id ?? interaction.user.id);
      } finally {
        await cleanupAgentRun(pending.threadId, typingInterval, toolTracker, agentResult);
      }
    });
    return;
  }

  // Handle automod keyword approval buttons: amka:{threadId}:{approve|reject}
  if (interaction.customId.startsWith(AUTOMOD_BTN_PREFIX)) {
    const rest = interaction.customId.slice(AUTOMOD_BTN_PREFIX.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon === -1) return;
    const threadId = rest.slice(0, lastColon);
    const choice = rest.slice(lastColon + 1); // "approve" | "reject"

    const pending = pendingAutomodApprovals.get(threadId);
    if (!pending) {
      await interaction.reply({ content: "This approval has expired — the bot was restarted. Please re-ask the agent to add the keyword.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== pending.triggeredByUserId) {
      await interaction.reply({
        content: `Only <@${pending.triggeredByUserId}> can respond to this approval.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    pendingAutomodApprovals.delete(threadId);
    await interaction.deferUpdate();
    await disableAutomodActionButtons(interaction as ButtonInteraction, "add", pending.ruleName, pending.keyword, choice === "approve");

    try {
      let systemMessage: string;

      if (choice === "approve") {
        try {
          const guild = await client.guilds.fetch(interaction.guildId!);
          // Re-fetch to get current live state — avoid overwriting concurrent changes
          const currentRule = await guild.autoModerationRules.fetch({ autoModerationRule: pending.ruleId, force: true });
          const currentFilter = [...(currentRule.triggerMetadata.keywordFilter ?? [])];
          const currentRegex = [...(currentRule.triggerMetadata.regexPatterns ?? [])];
          const currentAllow = [...(currentRule.triggerMetadata.allowList ?? [])];

          if (currentFilter.some(k => k.toLowerCase() === pending.keyword.toLowerCase())) {
            systemMessage = `[System: Moderator approved, but "${pending.keyword}" is already in rule "${pending.ruleName}" (added by someone else in the meantime). No changes made.]`;
          } else {
            await guild.autoModerationRules.edit(pending.ruleId, {
              triggerMetadata: {
                keywordFilter: [...currentFilter, pending.keyword],
                regexPatterns: currentRegex,
                allowList: currentAllow,
              },
              reason: `Added keyword "${pending.keyword}" via sushii-agent (approved by ${interaction.user.username})`,
            });
            const newCount = currentFilter.length + 1;
            const oldCount = currentFilter.length;
            systemMessage = `[System: Moderator approved. Keyword "${pending.keyword}" was successfully added to automod rule "${pending.ruleName}" (${oldCount} → ${newCount} keywords). The rule is now live.]`;
            logger.info({ ruleId: pending.ruleId, keyword: pending.keyword, guildId: interaction.guildId }, "automod keyword added");
          }
        } catch (err) {
          systemMessage = `[System: Moderator approved, but the Discord API call failed: ${err}. The keyword was NOT added. You may try again.]`;
          logger.error({ err, ruleId: pending.ruleId, keyword: pending.keyword }, "automod edit failed");
        }
      } else {
        systemMessage = `[System: Moderator rejected the keyword addition. "${pending.keyword}" was NOT added to rule "${pending.ruleName}".]`;
      }

      await resumeAgentAfterApproval(interaction as ButtonInteraction, threadId, systemMessage);
    } catch (err) {
      logger.error({ err }, "Unexpected error in automod approval handler");
    }
    return;
  }

  // Handle automod keyword deletion approval buttons: amkd:{threadId}:{approve|reject}
  if (interaction.customId.startsWith(AUTOMOD_DEL_BTN_PREFIX)) {
    const rest = interaction.customId.slice(AUTOMOD_DEL_BTN_PREFIX.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon === -1) return;
    const threadId = rest.slice(0, lastColon);
    const choice = rest.slice(lastColon + 1); // "approve" | "reject"

    const pending = pendingAutomodDeletions.get(threadId);
    if (!pending) {
      await interaction.reply({ content: "This approval has expired — the bot was restarted. Please re-ask the agent to remove the keyword.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== pending.triggeredByUserId) {
      await interaction.reply({
        content: `Only <@${pending.triggeredByUserId}> can respond to this approval.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    pendingAutomodDeletions.delete(threadId);
    await interaction.deferUpdate();
    await disableAutomodActionButtons(interaction as ButtonInteraction, "remove", pending.ruleName, pending.keyword, choice === "approve");

    try {
      let systemMessage: string;

      if (choice === "approve") {
        try {
          const guild = await client.guilds.fetch(interaction.guildId!);
          // Re-fetch to get current live state — avoid overwriting concurrent changes
          const currentRule = await guild.autoModerationRules.fetch({ autoModerationRule: pending.ruleId, force: true });
          const currentFilter = [...(currentRule.triggerMetadata.keywordFilter ?? [])];
          const currentRegex = [...(currentRule.triggerMetadata.regexPatterns ?? [])];
          const currentAllow = [...(currentRule.triggerMetadata.allowList ?? [])];

          const existingIdx = currentFilter.findIndex(k => k.toLowerCase() === pending.keyword.toLowerCase());
          if (existingIdx === -1) {
            systemMessage = `[System: Moderator approved, but "${pending.keyword}" is no longer in rule "${pending.ruleName}" (already removed by someone else in the meantime). No changes made.]`;
          } else {
            const newFilter = currentFilter.filter((_, i) => i !== existingIdx);
            await guild.autoModerationRules.edit(pending.ruleId, {
              triggerMetadata: {
                keywordFilter: newFilter,
                regexPatterns: currentRegex,
                allowList: currentAllow,
              },
              reason: `Removed keyword "${pending.keyword}" via sushii-agent (approved by ${interaction.user.username})`,
            });
            const oldCount = currentFilter.length;
            const newCount = newFilter.length;
            systemMessage = `[System: Moderator approved. Keyword "${pending.keyword}" was successfully removed from automod rule "${pending.ruleName}" (${oldCount} → ${newCount} keywords). The rule is now live.]`;
            logger.info({ ruleId: pending.ruleId, keyword: pending.keyword, guildId: interaction.guildId }, "automod keyword removed");
          }
        } catch (err) {
          systemMessage = `[System: Moderator approved, but the Discord API call failed: ${err}. The keyword was NOT removed. You may try again.]`;
          logger.error({ err, ruleId: pending.ruleId, keyword: pending.keyword }, "automod delete edit failed");
        }
      } else {
        systemMessage = `[System: Moderator rejected the keyword removal. "${pending.keyword}" was NOT removed from rule "${pending.ruleName}".]`;
      }

      await resumeAgentAfterApproval(interaction as ButtonInteraction, threadId, systemMessage);
    } catch (err) {
      logger.error({ err }, "Unexpected error in automod deletion approval handler");
    }
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
      logger.error({ err }, "Error handling button interaction");
      await thread.send("An error occurred while processing your response. Check the logs.").catch(() => {});
    } finally {
      await cleanupAgentRun(threadId, typingInterval, toolTracker, agentResult);
    }
  }); // end withThreadLock
  } catch (err) {
    logger.error({ err }, "Unexpected error in button interaction handler");
  }
});

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
    pendingChoices.set(threadId, { question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId });
    savePendingQuestion({ threadId, question: pendingQuestion.question, choices: pendingQuestion.choices, triggeredByUserId, createdAt: Date.now() });
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
    const expanded = expandMessageLinks(response, guildId);
    const componentMsgs = buildComponentMessages(expanded);
    appendFeedbackButtons(componentMsgs, threadId);
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

async function cleanupAgentRun(
  threadId: string,
  typingInterval: ReturnType<typeof setInterval>,
  toolTracker: ToolProgressTracker,
  agentResult: AgentLoopResult | undefined,
): Promise<void> {
  clearInterval(typingInterval);
  await toolTracker.finalize(agentResult?.cancelled ?? false).catch(() => {});
  threadCancellations.delete(threadId);
  threadTriggeringUsers.delete(threadId);
  const remainingQueue = threadMidLoopQueues.get(threadId) ?? [];
  for (const m of remainingQueue) {
    m.consumed = true;
    m.discordMessage.reactions.cache.get("⏳")?.users.remove(client.user!.id).catch(() => {});
  }
  threadMidLoopQueues.delete(threadId);
}

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
      logger.error({ err }, "Error resuming loop after approval");
      await thread.send("An error occurred while processing the approval. Check the logs.").catch(() => {});
    } finally {
      await cleanupAgentRun(threadId, typingInterval, toolTracker, agentResult);
    }
  });
}

function buildLoopOptions(
  thread: ThreadChannel,
  guildId: string,
  emojiMap: Record<string, string>,
  toolTracker: ToolProgressTracker,
  opts: {
    threadContext?: string;
    mentionedUsers?: Map<string, UserNames>;
    triggeringUser?: TriggeringUser;
    currentChannel?: ChannelContext;
    serverContext: string | null;
    memoryIndex: string[];
    memoryCount: number;
  },
): AgentLoopOptions {
  const threadId = thread.id;
  return {
    threadContext: opts.threadContext,
    currentChannelId: threadId,
    emojiMap,
    mentionedUsers: opts.mentionedUsers,
    botId: client.user!.id,
    botUsername: client.user!.username,
    triggeringUser: opts.triggeringUser,
    currentChannel: opts.currentChannel,
    serverContext: opts.serverContext,
    memoryIndex: opts.memoryIndex,
    memoryCount: opts.memoryCount,
    memoryLimit: MEMORY_LIMIT,
    onInterimText: async (text) => {
      await toolTracker.reset();
      const expanded = expandMessageLinks(text, guildId);
      const componentMsgs = buildComponentMessages(expanded);
      for (const msgOpts of componentMsgs) {
        await thread.send({ ...msgOpts, allowedMentions: { parse: [] } });
      }
      await thread.sendTyping();
    },
    onToolsDispatched: async (tools) => {
      toolTracker.add(tools);
    },
    dequeueMessages: makeDequeueMessages(threadId),
    isCancelled: () => threadCancellations.has(threadId),
  };
}

function makeDequeueMessages(threadId: string): () => { query: string; mentionedUsers?: Map<string, UserNames> }[] {
  return () => {
    const q = threadMidLoopQueues.get(threadId) ?? [];
    if (q.length === 0) return [];
    threadMidLoopQueues.set(threadId, []);
    for (const m of q) {
      m.consumed = true;
      m.discordMessage.reactions.cache.get("⏳")?.users.remove(client.user!.id).catch(() => {});
      m.discordMessage.react("✅").catch(() => {});
    }
    return q;
  };
}

/**
 * Build an alphabetical neighbor context string for an automod keyword.
 *
 * For additions (mode="add"): `existingKeywords` is the pre-addition list.
 * The new keyword is inserted at its sorted position and marked with arrows.
 *
 * For removals (mode="remove"): `existingKeywords` is the post-removal list
 * (the keyword has already been removed). The keyword is temporarily re-inserted
 * at its sorted position and marked with strikethrough, so the moderator can see
 * exactly where it sat among its neighbors.
 */
function buildNeighborContext(
  existingKeywords: string[],
  keyword: string,
  opts?: { windowSize?: number; mode?: "add" | "remove" },
): string {
  const windowSize = opts?.windowSize ?? 5;
  const isRemoval = opts?.mode === "remove";
  const sortKey = (k: string) => k.replace(/^\*+/, "").replace(/\*+$/, "").toLowerCase();
  const sorted = [...existingKeywords].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  // Find where the keyword sits (or would sit) in sorted order
  const insertIdx = sorted.findIndex(k => sortKey(k) > sortKey(keyword));
  const insertAt = insertIdx === -1 ? sorted.length : insertIdx;
  // For removals, temporarily re-insert the keyword at its sorted position for display
  const withKeyword = [...sorted.slice(0, insertAt), keyword, ...sorted.slice(insertAt)];
  const start = Math.max(0, insertAt - windowSize);
  const end = Math.min(withKeyword.length, insertAt + windowSize + 1);
  const neighbors = withKeyword.slice(start, end);
  const parts = neighbors.map((k, i) => {
    if (start + i === insertAt) {
      return isRemoval ? `~~\`${k}\`~~` : `**→ ${k} ←**`;
    }
    return `\`${k}\``;
  });
  return (start > 0 ? "... " : "") + parts.join(", ") + (end < withKeyword.length ? " ..." : "");
}

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

async function sendAutomodActionMessage(
  thread: ThreadChannel,
  params: {
    mode: "add" | "remove";
    btnPrefix: string;
    ruleName: string;
    ruleId: string;
    keyword: string;
    oldCount: number;
    newCount: number;
    neighborStr: string;
  },
): Promise<void> {
  const threadId = thread.id;
  const { mode, btnPrefix, ruleName, ruleId, keyword, oldCount, newCount, neighborStr } = params;
  const title = mode === "add"
    ? "🔒 **Automod keyword addition — awaiting approval**"
    : "🔒 **Automod keyword removal — awaiting approval**";
  const actionLabel = mode === "add" ? "Keyword to add" : "Keyword to remove";

  const bodyLines = [
    `**Rule:** ${ruleName} (\`${ruleId}\`)`,
    `**${actionLabel}:** \`${keyword}\``,
    `**Keywords:** ${oldCount} → ${newCount}`,
    "",
    `Alphabetical neighbors:`,
    neighborStr,
  ];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${btnPrefix}${threadId}:approve`)
      .setLabel("✅ Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${btnPrefix}${threadId}:reject`)
      .setLabel("❌ Reject")
      .setStyle(ButtonStyle.Danger),
  );

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `${title}\n\n${bodyLines.join("\n")}` }))
    .addActionRowComponents(row);

  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

async function sendAutomodApprovalMessage(thread: ThreadChannel, approval: PendingAutomodApproval): Promise<void> {
  // PendingAutomodApproval.newKeywordFilter already includes the new keyword (post-addition),
  // so oldCount = length - 1 and newCount = length.
  const oldCount = approval.newKeywordFilter.length - 1;
  const newCount = approval.newKeywordFilter.length;
  const existing = approval.newKeywordFilter.filter(k => k !== approval.keyword);
  const neighborStr = buildNeighborContext(existing, approval.keyword);
  await sendAutomodActionMessage(thread, {
    mode: "add",
    btnPrefix: AUTOMOD_BTN_PREFIX,
    ruleName: approval.ruleName,
    ruleId: approval.ruleId,
    keyword: approval.keyword,
    oldCount,
    newCount,
    neighborStr,
  });
}

async function disableAutomodActionButtons(
  interaction: ButtonInteraction,
  mode: "add" | "remove",
  ruleName: string,
  keyword: string,
  approved: boolean,
): Promise<void> {
  try {
    let label: string;
    if (mode === "add") {
      label = approved
        ? `✅ Approved: added \`${keyword}\` to "${ruleName}"`
        : `❌ Rejected: \`${keyword}\` not added to "${ruleName}"`;
    } else {
      label = approved
        ? `✅ Approved: removed \`${keyword}\` from "${ruleName}"`
        : `❌ Rejected: \`${keyword}\` kept in "${ruleName}"`;
    }
    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder({ content: `-# ${label}` }));
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical
  }
}

async function sendAutomodDeletionMessage(thread: ThreadChannel, deletion: PendingAutomodDeletion): Promise<void> {
  const oldCount = deletion.newKeywordFilter.length + 1;
  const newCount = deletion.newKeywordFilter.length;
  const neighborStr = buildNeighborContext(deletion.newKeywordFilter, deletion.keyword, { mode: "remove" });
  await sendAutomodActionMessage(thread, {
    mode: "remove",
    btnPrefix: AUTOMOD_DEL_BTN_PREFIX,
    ruleName: deletion.ruleName,
    ruleId: deletion.ruleId,
    keyword: deletion.keyword,
    oldCount,
    newCount,
    neighborStr,
  });
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
