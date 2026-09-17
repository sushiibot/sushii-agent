import {
  ChannelType,
  Events,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Message,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from "discord.js";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { AgentCore, AuthorRef, ChannelRef, ConversationRef, HookBus, InboundMessage, ToolHosts } from "../../core/contracts.ts";
import { conversationKey } from "../../core/contracts.ts";
import { DiscordConversationStore } from "../../core/stores/conversationStore.ts";
import { config, buildEmojiMap, resolvedModules } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getDb } from "../../db/index.ts";
import { insertMessage, updateMessageContent, softDeleteMessage, deleteOldMessages } from "../../db/messages.ts";
import { savePendingQuestion, loadPendingQuestion, deletePendingQuestion, deleteStalePendingQuestions } from "../../db/pendingQuestions.ts";
import { buildMessageContent } from "../../utils/flattenMessage.ts";
import { isPrivateChannel } from "../../tools/channelUtils.ts";
import { BEHAVIOR_INSTRUCTIONS, buildAutoModPromptSection } from "../../modules/moderation/prompt.ts";
import type { AutoModTriggerContext } from "../../agent/loop.ts";
import { buildOpsTriagePromptSection } from "../../modules/ops-triage/prompt.ts";
import { isAutoModEligible, checkAndSetAutoModCooldown } from "../../modules/moderation/dispatch.ts";
import { registerWikiSyncCommands, handleWikiSyncCommand, WIKI_SYNC_COMMAND_NAME, startWikiSyncScheduler } from "../../modules/wiki-sync/index.ts";
import { DiscordHost } from "./hosts/discordHost.ts";
import { DiscordMessageCacheHost } from "./hosts/messageCacheHost.ts";
import { SushiMcpHost } from "./hosts/sushiMcpHost.ts";
import { DiscordSurfaceSession } from "./session.ts";
import { attachDiscordMessage, registerDiscordHooks } from "./hooks.ts";
import { ToolProgressTracker, buildTextDisplayContainer } from "./delivery.ts";
import { renderDiscordText } from "./render.ts";
import { handleFeedbackButton, handleFeedbackModal } from "./feedback.ts";
import { STOP_BTN_PREFIX, ASK_BTN_PREFIX, FEEDBACK_BTN_PREFIX, FEEDBACK_MODAL_PREFIX, SCAN_BTN_PREFIX, AUTOMOD_BTN_PREFIX, AUTOMOD_DEL_BTN_PREFIX } from "./buttonIds.ts";

const logger = getLogger("surfaces/discord/gateway");
const tracer = trace.getTracer("sushii-agent");

const SURFACE = "discord" as const;
const DEFAULT_THREAD_NAME = "sushii-agent investigation";
const INTERSTITIAL_MAX_CHARS = 8000;

function withInteractionSpan<T>(name: string, attributes: Record<string, string | undefined>, fn: (span: Span) => Promise<T>): Promise<T> {
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

// ── Discord → neutral mapping ─────────────────────────────────────────────────

function getChannelRef(message: Message): ChannelRef {
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

function triggeringAuthor(message: Message, allowedRoles: string[]): AuthorRef {
  const roles = message.member
    ? [...message.member.roles.cache.values()]
        .filter((r) => r.id !== message.guild?.roles.everyone.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name }))
    : [];
  const displayName = message.member?.displayName !== message.author.username ? message.member?.displayName ?? null : null;
  return {
    surface: SURFACE,
    userId: message.author.id,
    username: message.author.username,
    displayName,
    isModerator: message.member?.roles.cache.hasAny(...allowedRoles) ?? false,
    roles,
  };
}

async function isReplyToBot(message: Message, botId: string): Promise<boolean> {
  if (!message.reference?.messageId) return false;
  try {
    const ref = message.channel.messages.cache.get(message.reference.messageId) ?? (await message.channel.messages.fetch(message.reference.messageId));
    return ref.author.id === botId;
  } catch {
    return false;
  }
}

function formatMessageLine(m: Message): string {
  const ts = Math.floor(m.createdTimestamp / 1000);
  const botSuffix = m.author.bot ? " [bot]" : "";
  return `t:${ts}:R u:${m.author.id} (${m.author.username}${botSuffix}): ${buildMessageContent(m)}`;
}

async function fetchThreadContext(thread: ThreadChannel, botId: string, limit = 100): Promise<string> {
  const fetched = await thread.messages.fetch({ limit });
  return [...fetched.values()]
    .filter((m) => m.author.id !== botId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(formatMessageLine)
    .join("\n");
}

async function fetchParentChannelContext(triggerMessage: Message, botId: string, limit = 20): Promise<string> {
  if (triggerMessage.channel.isThread()) return "";
  const fetched = await triggerMessage.channel.messages.fetch({ before: triggerMessage.id, limit });
  return [...fetched.values()]
    .filter((m) => m.author.id !== botId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(formatMessageLine)
    .join("\n");
}

async function fetchInterstitialMessages(thread: ThreadChannel, botId: string, excludeIds: Set<string>, limit = 100): Promise<string> {
  const fetched = await thread.messages.fetch({ limit });
  const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  let lastBotIdx = -1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].author.id === botId) { lastBotIdx = i; break; }
  }
  if (lastBotIdx === -1) logger.warn({ threadId: thread.id, limit }, "no bot message within interstitial window, using full window");
  const since = ordered.slice(lastBotIdx + 1).filter((m) => m.author.id !== botId && !excludeIds.has(m.id));
  const lines = since.map(formatMessageLine);
  let used = 0;
  let startIdx = lines.length;
  while (startIdx > 0 && used + lines[startIdx - 1].length + 1 <= INTERSTITIAL_MAX_CHARS) {
    startIdx--;
    used += lines[startIdx].length + 1;
  }
  if (startIdx === lines.length && lines.length > 0) {
    startIdx = lines.length - 1;
    lines[startIdx] = lines[startIdx].slice(0, INTERSTITIAL_MAX_CHARS);
  }
  const kept = lines.slice(startIdx);
  if (startIdx > 0) kept.unshift(`[${startIdx} older message(s) omitted]`);
  return kept.join("\n");
}

async function resolveOrCreateThread(message: Message): Promise<{ thread: ThreadChannel; isNew: boolean }> {
  if (message.channel.isThread()) return { thread: message.channel as ThreadChannel, isNew: false };
  const thread = await message.startThread({ name: DEFAULT_THREAD_NAME });
  return { thread, isNew: true };
}

function buildHosts(client: Client<true>, guildId: string): ToolHosts {
  const guildConfig = config.guildConfig[guildId];
  const mcp = config.sushiiMcpUrl && config.sushiiMcpToken ? new SushiMcpHost(config.sushiiMcpUrl, config.sushiiMcpToken, guildId) : undefined;
  return {
    discord: new DiscordHost(client, guildId, guildConfig),
    messageCache: new DiscordMessageCacheHost(getDb(), guildId, client),
    mcp,
  };
}

// ── Surface wiring ────────────────────────────────────────────────────────────

export interface DiscordSurfaceDeps {
  client: Client<true>;
  core: AgentCore;
  store: DiscordConversationStore;
  hookBus: HookBus;
}

export function startDiscordSurface(deps: DiscordSurfaceDeps): void {
  const { client, core, store, hookBus } = deps;
  // One ToolProgressTracker per active conversation. The onToolsDispatched hook and the session
  // that renders the reply share the same instance; the gateway finalizes + removes it when the
  // turn that owns it (not a queued mid-loop message) finishes.
  const trackers = new Map<string, ToolProgressTracker>();

  registerDiscordHooks(hookBus, {
    resolveThread: async (conversation) => {
      const ch = await client.channels.fetch(conversation.conversationId).catch(() => null);
      return ch?.isThread() ? (ch as ThreadChannel) : null;
    },
    getToolTracker: (conversation) => trackers.get(conversationKey(conversation)),
  });

  async function persistPending(conversation: ConversationRef, res: Awaited<ReturnType<AgentCore["handleInbound"]>>, thread: ThreadChannel): Promise<void> {
    if (res.status !== "paused") return;
    if (res.pending.kind === "question") {
      const { question, choices, authorizedResponder } = res.pending.payload;
      savePendingQuestion({ threadId: conversation.conversationId, question, choices, triggeredByUserId: authorizedResponder.userId, createdAt: Date.now() });
    } else {
      // Auto-mod keyword approval buttons are sent by the core via session.presentInteraction, but
      // the amka:/amkd: handlers that apply the change land in U4-cutover phase 2b.
      await thread.send({ content: "-# *(approval handling is being updated — please retry shortly)*", allowedMentions: { parse: [] } }).catch(() => {});
    }
  }

  /** Runs one turn/resume through the core and applies the surface-side result policy. The session
   *  already delivered any completed reply and presented any pause; this only covers what delivery
   *  does not: pending persistence, the cancelled note, the error reply, and tracker teardown. */
  async function runThroughCore(
    conversation: ConversationRef,
    thread: ThreadChannel,
    tracker: ToolProgressTracker,
    span: Span,
    run: () => Promise<Awaited<ReturnType<AgentCore["handleInbound"]>>>,
  ): Promise<void> {
    const key = conversationKey(conversation);
    const alreadyActive = trackers.has(key);
    if (!alreadyActive) trackers.set(key, tracker);
    let res: Awaited<ReturnType<AgentCore["handleInbound"]>> | undefined;
    try {
      res = await run();
      if (res.status === "cancelled") {
        await thread.send({ content: "-# *(loop stopped)*", allowedMentions: { parse: [] } }).catch(() => {});
      } else if (res.status === "error") {
        const traceId = span.spanContext().traceId;
        await thread.send(`An error occurred while processing your request.\n-# trace: ${traceId}`).catch(() => {});
      } else if (res.status === "paused") {
        await persistPending(conversation, res, thread);
      }
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : errMsg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      logger.error({ err }, "Error running turn through core");
      const traceId = span.spanContext().traceId;
      await thread.send(`An error occurred while processing your request.\n-# trace: ${traceId}`).catch(() => {});
    } finally {
      if (res?.status !== "queued" && !alreadyActive) {
        await trackers.get(key)?.finalize(res?.status === "cancelled").catch(() => {});
        trackers.delete(key);
      }
    }
  }

  // ── MessageCreate ────────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.guildId) return;
    const guildConfig = config.guildConfig[message.guildId];
    if (!guildConfig) return;
    const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

    // Cache every message from configured guilds, including bots.
    insertMessage(message);
    if (message.author.bot) return;
    if (!resolvedModules(guildConfig).includes("moderation")) return;

    // Auto-mod trigger: mod role pinged by an authorized role (no bot mention required).
    if (isAutoModEligible(message, guildConfig)) {
      if (!checkAndSetAutoModCooldown(message.guildId, message.channelId, guildConfig)) {
        logger.debug({ guildId: message.guildId, channelId: message.channelId }, "auto-mod trigger suppressed by cooldown");
        return;
      }
      void handleAutoModTrigger(message, message.guildId, emojiMap);
      return;
    }

    const isMention = message.mentions.has(client.user.id);
    const isReply = !isMention && (await isReplyToBot(message, client.user.id));
    if (!isMention && !isReply) return;
    if (!message.member?.roles.cache.hasAny(...guildConfig.allowedRoles)) return;

    const guildId = message.guildId;
    const botMentionRe = new RegExp(`<@!?${client.user.id}>`, "g");
    const rawQuery = message.content.replace(botMentionRe, "").trim();
    const isBarePing = rawQuery.length === 0;
    const emojiQuery = rawQuery.replace(/<a?:(\w+):\d+>/g, (match, name) => emojiMap[name] ?? match);
    const normalizedQuery = emojiQuery.replace(/https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/g, "msg:$1/$2");

    const mentioned = new Map<string, AuthorRef>();
    for (const [userId, user] of message.mentions.users) {
      if (userId === client.user.id) continue;
      const member = message.mentions.members?.get(userId);
      const displayName = member?.displayName ?? user.displayName;
      mentioned.set(userId, { surface: SURFACE, userId, username: user.username, displayName: displayName !== user.username ? displayName : null });
    }

    let replyContext = "";
    if (isMention && message.reference?.messageId) {
      try {
        const refMsg = message.channel.messages.cache.get(message.reference.messageId) ?? (await message.channel.messages.fetch(message.reference.messageId));
        if (refMsg.author.id !== client.user.id) {
          replyContext = `Replying to u:${refMsg.author.id} (${refMsg.author.username}):\n${buildMessageContent(refMsg)}\n\n`;
          for (const [userId, user] of refMsg.mentions.users) {
            if (!mentioned.has(userId)) mentioned.set(userId, { surface: SURFACE, userId, username: user.username, displayName: null });
          }
        }
      } catch {
        // Ignore fetch errors — proceed without context.
      }
    }

    let body: string;
    if (!isBarePing) {
      body = normalizedQuery;
    } else {
      const flattened = buildMessageContent(message).replace(botMentionRe, "").trim();
      const attached = flattened && flattened !== "[empty message]" ? `${flattened}\n` : "";
      body = `${attached}[No message text — review the recent activity shown in your context, investigate anything unclear or needing moderator attention, and summarize what's going on. If nothing needs attention, say so briefly.]`;
    }
    const baseText = `${replyContext}[Message from ${message.author.username} (<@${message.author.id}>)]\n${body}`;

    const author = triggeringAuthor(message, guildConfig.allowedRoles);
    const channel = getChannelRef(message);
    const trigger = isMention ? "mention" : "reply";
    logger.info({ trigger, username: message.author.username, userId: author.userId, channelId: message.channelId }, "triggered");

    await tracer.startActiveSpan("discord.message", {
      attributes: {
        "discord.guild_id": guildId,
        "discord.channel_id": message.channelId,
        "discord.message_id": message.id,
        "discord.user_id": author.userId,
        "discord.trigger": trigger,
      },
    }, async (span) => {
      try {
        const { thread, isNew } = await resolveOrCreateThread(message);
        span.setAttribute("discord.thread_id", thread.id);
        const conversation: ConversationRef = { surface: SURFACE, spaceId: guildId, conversationId: thread.id };

        const { messages: existingHistory, initialThreadContext } = store.load(conversation);
        let threadContext: string;
        if (initialThreadContext != null) threadContext = initialThreadContext;
        else if (isNew) threadContext = await fetchParentChannelContext(message, client.user.id);
        else threadContext = await fetchThreadContext(thread, client.user.id);

        // threadContext is frozen after the first turn (prompt-cache stability), so new thread
        // activity since the last reply is appended to the query instead of the (frozen) context.
        let turnText = baseText;
        if (existingHistory.length > 0 && initialThreadContext != null) {
          const interstitial = await fetchInterstitialMessages(thread, client.user.id, new Set([message.id]));
          if (interstitial) turnText = `[Thread activity since your last response]\n${interstitial}\n\n${baseText}`;
        }

        const ownerSection = config.ownerDiscordId && author.userId === config.ownerDiscordId ? buildOpsTriagePromptSection() : undefined;
        const tracker = new ToolProgressTracker(thread);
        const session = new DiscordSurfaceSession({
          client,
          thread,
          guildId,
          emojiMap,
          hosts: buildHosts(client, guildId),
          toolTracker: tracker,
          channel,
          threadContext: threadContext || undefined,
          threadChannelId: thread.id,
          ownerSection,
          moduleExtras: undefined,
        });

        const inbound: InboundMessage = {
          conversation,
          author,
          text: turnText,
          mentionedUsers: mentioned.size ? [...mentioned.values()] : undefined,
          channel,
        };
        attachDiscordMessage(inbound, message);

        await runThroughCore(conversation, thread, tracker, span, () => core.handleInbound(inbound, session));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : errMsg);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
        logger.error({ err }, "Error handling mention");
        try {
          await message.reply(`An error occurred while processing your request.\n-# trace: ${span.spanContext().traceId}`);
        } catch {
          // Ignore reply errors.
        }
      } finally {
        span.end();
      }
    });
  });

  // ── Auto-mod trigger ──────────────────────────────────────────────────────────
  async function handleAutoModTrigger(message: Message, guildId: string, emojiMap: Record<string, string>): Promise<void> {
    const guildConfig = config.guildConfig[guildId];
    const modRoleId = guildConfig.modRoleId;
    const alertsChannelId = guildConfig.alertsChannelId;
    if (!modRoleId || !alertsChannelId) return;

    try {
      const alertsChannel = await client.channels.fetch(alertsChannelId);
      if (!alertsChannel?.isTextBased() || alertsChannel.isDMBased() || alertsChannel.guildId !== guildId) {
        logger.error({ alertsChannelId }, "alertsChannelId is not a guild text channel");
        return;
      }
      const incidentChannelName = message.channel.isTextBased() && !message.channel.isDMBased() && "name" in message.channel
        ? (message.channel as { name: string }).name
        : message.channelId;
      const triggerMessageLink = `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
      const anchor = await alertsChannel.send({
        components: [buildTextDisplayContainer(`🔍 Auto-mod investigating an incident in <#${message.channelId}> — [triggering message](${triggerMessageLink})...`)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [] },
      });
      const thread = await anchor.startThread({ name: "auto-mod investigation" });

      let repliedToUserId: string | undefined;
      let repliedToMessageId: string | undefined;
      if (message.reference?.messageId) {
        try {
          const ref = await message.channel.messages.fetch(message.reference.messageId);
          if (ref && !ref.author.bot) { repliedToUserId = ref.author.id; repliedToMessageId = ref.id; }
        } catch {
          // non-fatal
        }
      }

      const immuneIds = [...new Set([...(guildConfig.modImmuneRoleIds ?? []), ...guildConfig.allowedRoles])];
      const newMemberThresholdDays = guildConfig.newMemberThresholdDays ?? 3;
      const autoModTrigger: AutoModTriggerContext = {
        reporterUserId: message.author.id,
        reporterUsername: message.author.username,
        incidentChannelId: message.channelId,
        incidentChannelName,
        triggerMessageContent: message.content.slice(0, 500),
        triggerMessageId: message.id,
        repliedToUserId,
        repliedToMessageId,
        modRoleId,
        modImmuneRoleIds: immuneIds,
        newMemberThresholdDays,
        anchorMessageId: anchor.id,
      };

      const guildId2 = guildId;
      const conversation: ConversationRef = { surface: SURFACE, spaceId: guildId2, conversationId: thread.id };
      const { initialThreadContext } = store.load(conversation);
      const threadContext = initialThreadContext ?? "";
      const query = `[Auto-mod trigger] Mod role was pinged by ${message.author.username} in #${incidentChannelName}. Message: "${message.content.slice(0, 300)}"`;

      await tracer.startActiveSpan("discord.automod", { attributes: { "discord.guild_id": guildId2, "discord.thread_id": thread.id } }, async (span) => {
        try {
          const tracker = new ToolProgressTracker(thread);
          const session = new DiscordSurfaceSession({
            client,
            thread,
            guildId: guildId2,
            emojiMap,
            hosts: buildHosts(client, guildId2),
            toolTracker: tracker,
            channel: undefined,
            threadContext: threadContext || undefined,
            threadChannelId: thread.id,
            moduleExtras: [buildAutoModPromptSection(autoModTrigger)],
          });
          const inbound: InboundMessage = {
            conversation,
            author: { surface: SURFACE, userId: message.author.id, username: message.author.username },
            text: query,
            platform: {
              surface: "discord",
              autoModTrigger: {
                ruleName: "mod-ping",
                keyword: "",
                channelId: message.channelId,
                content: autoModTrigger.triggerMessageContent,
                anchorMessageId: anchor.id,
                incidentChannelId: message.channelId,
                triggerMessageId: message.id,
              },
            },
          };
          attachDiscordMessage(inbound, message);
          await runThroughCore(conversation, thread, tracker, span, () => core.handleInbound(inbound, session));
        } finally {
          span.end();
        }
      });
    } catch (err) {
      logger.error({ err, guildId, channelId: message.channelId }, "Error in handleAutoModTrigger");
    }
  }

  // ── InteractionCreate ─────────────────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit() && interaction.customId.startsWith(FEEDBACK_MODAL_PREFIX)) {
      await handleFeedbackModal(interaction as ModalSubmitInteraction, store);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === WIKI_SYNC_COMMAND_NAME) {
      await handleWikiSyncCommand(interaction);
      return;
    }
    if (!interaction.isButton()) return;
    const btn = interaction as ButtonInteraction;

    if (btn.customId.startsWith(STOP_BTN_PREFIX)) {
      await handleStopButton(btn);
      return;
    }
    if (btn.customId.startsWith(FEEDBACK_BTN_PREFIX)) {
      await handleFeedbackButton(btn);
      return;
    }
    if (btn.customId.startsWith(SCAN_BTN_PREFIX) || btn.customId.startsWith(AUTOMOD_BTN_PREFIX) || btn.customId.startsWith(AUTOMOD_DEL_BTN_PREFIX)) {
      // Scan-approval + auto-mod-approval handlers land in U4-cutover phase 2b.
      await btn.reply({ content: "This action is being updated — please try again shortly.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (btn.customId.startsWith(ASK_BTN_PREFIX)) {
      await handleAskButton(btn);
      return;
    }
  });

  async function handleStopButton(interaction: ButtonInteraction): Promise<void> {
    const threadId = interaction.customId.slice(STOP_BTN_PREFIX.length);
    const guildId = interaction.guildId;
    if (!guildId) return;
    const conversation: ConversationRef = { surface: SURFACE, spaceId: guildId, conversationId: threadId };
    const by: AuthorRef = { surface: SURFACE, userId: interaction.user.id, username: interaction.user.username };
    const outcome = core.cancel(conversation, by);
    if (outcome.status === "no-active-turn") {
      await interaction.reply({ content: "No active loop to stop.", flags: MessageFlags.Ephemeral });
    } else if (outcome.status === "forbidden") {
      await interaction.reply({ content: "Only the person who triggered this loop can stop it.", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "Stopping...", flags: MessageFlags.Ephemeral });
    }
  }

  async function handleAskButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.slice(ASK_BTN_PREFIX.length).split(":");
    if (parts.length !== 2) return;
    const [threadId, indexStr] = parts;
    const choiceIndex = parseInt(indexStr, 10);

    const pending = loadPendingQuestion(threadId);
    if (!pending || isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= pending.choices.length) {
      await interaction.reply({ content: "This question has expired — the bot was restarted. Please re-ask your query.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== pending.triggeredByUserId) {
      await interaction.reply({ content: `Only <@${pending.triggeredByUserId}> can respond to this question.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const choice = pending.choices[choiceIndex];
    deletePendingQuestion(threadId);
    await interaction.deferUpdate();
    await disableAskButtons(interaction, pending.question, choice);

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread?.isThread()) return;
    const guildId = thread.guildId;
    const guildConfig = config.guildConfig[guildId];
    if (!guildConfig) return;
    const conversation: ConversationRef = { surface: SURFACE, spaceId: guildId, conversationId: threadId };

    await withInteractionSpan("discord.interaction", { "discord.thread_id": threadId, "discord.guild_id": guildId, "discord.user_id": interaction.user.id, "discord.trigger": "ask_question_choice" }, async (span) => {
      const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);
      const { initialThreadContext } = store.load(conversation);
      const by = await memberAuthor(thread, interaction.user.id, guildConfig.allowedRoles);
      const channel = threadChannelRef(thread);
      const ownerSection = config.ownerDiscordId && by.userId === config.ownerDiscordId ? buildOpsTriagePromptSection() : undefined;
      const tracker = new ToolProgressTracker(thread);
      const session = new DiscordSurfaceSession({
        client,
        thread,
        guildId,
        emojiMap,
        hosts: buildHosts(client, guildId),
        toolTracker: tracker,
        channel,
        threadContext: initialThreadContext ?? undefined,
        threadChannelId: thread.id,
        ownerSection,
      });
      await runThroughCore(conversation, thread, tracker, span, () => core.resume(conversation, { kind: "question-answer", choice, by }, session));
    });
  }

  // ── Message cache lifecycle ─────────────────────────────────────────────────
  client.on(Events.MessageUpdate, (_old, newMsg) => {
    if (!newMsg.guildId || newMsg.partial) return;
    updateMessageContent(newMsg.id, buildMessageContent(newMsg as Message), newMsg.editedTimestamp ?? Date.now());
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

  // Startup cleanup schedules (ported from the old startBot()).
  deleteOldMessages();
  setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);
  store.deleteStale(90 * 24 * 60 * 60 * 1000);
  setInterval(() => store.deleteStale(90 * 24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
  deleteStalePendingQuestions(24 * 60 * 60 * 1000);
  setInterval(() => deleteStalePendingQuestions(24 * 60 * 60 * 1000), 60 * 60 * 1000);
}

// Helpers reused by the ask-button resume path.
function threadChannelRef(thread: ThreadChannel): ChannelRef {
  const isPrivate = thread.type === ChannelType.PrivateThread;
  return {
    id: thread.id,
    name: thread.name,
    type: isPrivate ? "thread (private)" : "thread (public)",
    isPrivate,
    parentChannelId: thread.parentId ?? undefined,
    parentChannelName: thread.parent?.name ?? undefined,
  };
}

async function memberAuthor(thread: ThreadChannel, userId: string, allowedRoles: string[]): Promise<AuthorRef> {
  const member = await thread.guild.members.fetch(userId).catch(() => null);
  const roles = member
    ? [...member.roles.cache.values()].filter((r) => r.id !== thread.guild.roles.everyone.id).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name }))
    : [];
  const username = member?.user.username ?? null;
  const displayName = member && member.displayName !== member.user.username ? member.displayName : null;
  return { surface: "discord", userId, username, displayName, isModerator: member?.roles.cache.hasAny(...allowedRoles) ?? false, roles };
}

async function disableAskButtons(interaction: ButtonInteraction, question: string, chosen: string): Promise<void> {
  try {
    const expanded = renderDiscordText(question, interaction.guildId ?? "");
    const container = buildTextDisplayContainer(`${expanded}\n-# Selected: ${chosen}`);
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical — if we can't update the message, just continue.
  }
}
