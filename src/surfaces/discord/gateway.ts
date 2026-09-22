import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { SqliteConversationStore } from "../../core/stores/conversationStore.ts";
import { DiscordSpaceMemoryStore } from "../../core/stores/memoryStore.ts";
import { config, buildEmojiMap, resolvedModules } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getDb } from "../../db/index.ts";
import { insertMessage, updateMessageContent, softDeleteMessage, deleteOldMessages } from "../../db/messages.ts";
import { savePendingQuestion, loadPendingQuestion, deletePendingQuestion, deleteStalePendingQuestions } from "../../db/pendingQuestions.ts";
import { buildMessageContent } from "../../utils/flattenMessage.ts";
import { isPrivateChannel } from "../../tools/channelUtils.ts";
import { BEHAVIOR_INSTRUCTIONS, buildAutoModPromptSection, type AutoModTriggerContext } from "../../modules/moderation/prompt.ts";
import { buildOpsTriagePromptSection } from "../../modules/ops-triage/prompt.ts";
import { isAutoModEligible, checkAndSetAutoModCooldown } from "./autoModTrigger.ts";
import { registerWikiSyncCommands, handleWikiSyncCommand, WIKI_SYNC_COMMAND_NAME } from "../../modules/wiki-sync/index.ts";
import { createDiscordWikiSyncContext } from "./wikiSync.ts";
import { createWikiFsHost } from "../../modules/wiki-sync/wikiHost.ts";
import { DiscordHost } from "./hosts/discordHost.ts";
import { DiscordMessageCacheHost } from "./hosts/messageCacheHost.ts";
import { SushiMcpHost } from "./hosts/sushiMcpHost.ts";
import { DiscordSurfaceSession } from "./session.ts";
import { attachDiscordMessage, registerDiscordHooks } from "./hooks.ts";
import { ToolProgressTracker, buildTextDisplayContainer } from "./delivery.ts";
import { renderDiscordText } from "./render.ts";
import { handleFeedbackButton, handleFeedbackModal } from "./feedback.ts";
import { SCAN_QUERY, applyAutomodDecision } from "./approvals.ts";
import { buildTriggerText } from "./inbound.ts";
import { STOP_BTN_PREFIX, ASK_BTN_PREFIX, FEEDBACK_BTN_PREFIX, FEEDBACK_MODAL_PREFIX, AUTOMOD_BTN_PREFIX, AUTOMOD_DEL_BTN_PREFIX } from "./buttonIds.ts";
import { DispatcherUnavailableError, getDispatcher } from "../../orchestration/dispatcher.ts";
import type { TaskRow } from "../../orchestration/contracts.ts";
import { getActivityHub, taskViewUrl } from "../../orchestration/activityHub.ts";
import { buildTaskMeta } from "../../orchestration/taskMeta.ts";
import { askPings, hasLiveTaskView, LiveTaskView, TASK_ANS_PREFIX, TASK_CTL_PREFIX } from "./liveTask.ts";
import { DM_SPACE_ID, DmConductorSession, isOwnerDm } from "./dmConductor.ts";

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
  // The read/search/list_files tools are host-gated on `fs`: expose them only for guilds with
  // wiki-sync enabled, rooted at their synced wiki. (Any future FS source wires the same way.)
  const fs = guildConfig && resolvedModules(guildConfig).includes("wiki-sync") ? createWikiFsHost(guildId) : undefined;
  return {
    discord: new DiscordHost(client, guildId, guildConfig),
    messageCache: new DiscordMessageCacheHost(getDb(), guildId, client),
    mcp,
    fs,
  };
}

// ── Surface wiring ────────────────────────────────────────────────────────────

export interface DiscordSurfaceDeps {
  client: Client<true>;
  core: AgentCore;
  store: SqliteConversationStore;
  memory: DiscordSpaceMemoryStore;
  hookBus: HookBus;
}

/** A paused automod approval, recovered when the amka:/amkd: button is clicked. In-memory only,
 *  matching the pre-cutover behavior (approvals did not survive a restart). */
interface PendingApproval {
  action: "automod-keyword-add" | "automod-keyword-delete";
  ruleId: string;
  ruleName: string;
  keyword: string;
  triggeredByUserId: string;
}

export function startDiscordSurface(deps: DiscordSurfaceDeps): void {
  const { client, core, store, memory, hookBus } = deps;
  // One ToolProgressTracker per active conversation. The onToolsDispatched hook and the session
  // that renders the reply share the same instance; the gateway finalizes + removes it when the
  // turn that owns it (not a queued mid-loop message) finishes.
  const trackers = new Map<string, ToolProgressTracker>();
  // Guilds whose first-run auto-scan has been attempted this process (success or failure), so a
  // failing scan is not retried on every mention.
  const scannedGuilds = new Set<string>();
  // In-flight scans, so mentions arriving during a scan await the same one (and get its context)
  // instead of racing ahead with empty awareness.
  const scanningGuilds = new Map<string, Promise<void>>();
  const pendingApprovals = new Map<string, PendingApproval>();

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
      // The rich approve/reject buttons were already sent by the core via session.presentInteraction;
      // hold the change details in memory so the amka:/amkd: handler can apply them (parity: this
      // state did not survive a restart before, and still does not).
      const p = res.pending.payload;
      pendingApprovals.set(conversation.conversationId, {
        action: p.action,
        ruleId: p.platform.ruleId ?? "",
        ruleName: p.platform.ruleName ?? "",
        keyword: p.platform.keyword ?? "",
        triggeredByUserId: p.authorizedResponder.userId,
      });
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
      // The core swallows in-turn failures into { status: "error" } (delivery included), so label the
      // span from the returned status rather than assuming success just because run() didn't throw.
      if (res.status === "error") span.setStatus({ code: SpanStatusCode.ERROR, message: res.message });
      else span.setStatus({ code: SpanStatusCode.OK });
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

  /** Owner-only DM conductor turn: builds a personal `spaceId` ("dm") that authz.isPersonalSpace
   *  accepts, then runs the normal core loop — runner tools (dispatch_to_runner/resume_session/...)
   *  become available via the tool registry's isPersonalSpace gate. Never touches the guild path. */
  async function handleOwnerDm(message: Message): Promise<void> {
    if (!message.channel.isSendable()) return;
    const channel = message.channel;

    // Deterministic DM session boundary. A DM has no threads (unlike guilds, where each thread is a
    // fresh conversation), so this is the manual "start fresh" for the owner's one ever-growing DM.
    // A `!` prefix (not `/`) avoids triggering Discord's slash-command autocomplete/registry.
    const dmCommand = message.content.trim().toLowerCase();
    if (dmCommand === "!new" || dmCommand === "!reset" || dmCommand === "!clear") {
      const conversation: ConversationRef = { surface: SURFACE, spaceId: DM_SPACE_ID, conversationId: message.channelId };
      store.save(conversation, { messages: [], initialThreadContext: null });
      await message.react("✅").catch(() => {});
      await channel.send("Started a fresh conversation — this chat's history is cleared. Durable memory is unaffected.").catch(() => {});
      return;
    }

    // Immediate receipt ack — the turn (and any dispatch it kicks off) can take a while, so react
    // right away so the owner knows the DM was seen and is being worked on.
    await message.react("👀").catch(() => {});

    const conversation: ConversationRef = { surface: SURFACE, spaceId: DM_SPACE_ID, conversationId: message.channelId };
    const author: AuthorRef = { surface: SURFACE, userId: message.author.id, username: message.author.username };
    const session = new DmConductorSession(channel, { id: client.user.id, username: client.user.username });
    const inbound: InboundMessage = { conversation, author, text: message.content };

    await tracer.startActiveSpan("discord.dm", {
      attributes: { "discord.user_id": author.userId, "discord.channel_id": message.channelId },
    }, async (span) => {
      try {
        const res = await core.handleInbound(inbound, session);
        if (res.status === "error") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: res.message });
          await channel.send(`An error occurred while processing your request.\n-# trace: ${span.spanContext().traceId}`).catch(() => {});
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : errMsg);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
        logger.error({ err }, "Error handling owner DM");
        await channel.send(`An error occurred while processing your request.\n-# trace: ${span.spanContext().traceId}`).catch(() => {});
      } finally {
        span.end();
      }
    });
  }

  /** Posts a deterministic (LLM-free) status line to the task's originating DM when a turn
   *  SETTLES — {idle, done, failed} (a successful turn rests at idle, not done; see
   *  ARCHITECTURE.md's status model). The dispatcher only invokes a callback — this is the one
   *  place in the whole feature that imports discord.js for it. Discord DMs are 1:1 per user, so
   *  `task.createdBy` (the owner's Discord user id, already stored — no schema change) is enough
   *  to resolve the target: no separate notify-target field needs threading through ToolContext. */
  async function notifyTaskSettled(task: TaskRow): Promise<void> {
    if (task.spawnedFromSurface !== SURFACE) return;
    const user = await client.users
      .fetch(task.createdBy)
      .catch((err) => {
        logger.warn({ err, taskId: task.id, userId: task.createdBy }, "failed to fetch task-settled DM recipient");
        return null;
      });
    if (!user) return;
    const line = task.status === "failed"
      ? `❌ #${task.id} failed — ${task.statusReason ?? "(no reason given)"}`
      : `✅ #${task.id} — ${task.summary ?? "(no summary)"}`;
    await user.send(line).catch((err) => logger.warn({ err, taskId: task.id }, "failed to send task-settled DM"));
  }

  /** Owner-only ops notice (startup, runner connect/disconnect). Best-effort — a failed DM never
   *  affects the bot; owner DMs are 1:1 so config.ownerDiscordId is the whole address. Sent silently
   *  (SuppressNotifications) — these are routine status pings, not something to buzz the owner for. */
  async function notifyOwner(text: string): Promise<void> {
    if (!config.ownerDiscordId) return;
    const user = await client.users.fetch(config.ownerDiscordId).catch(() => null);
    if (!user) return;
    await user
      .send({ content: text, flags: MessageFlags.SuppressNotifications })
      .catch((err) => logger.warn({ err }, "failed to send owner ops DM"));
  }

  try {
    const dispatcher = getDispatcher();
    dispatcher.onTaskSettled((task) => {
      void notifyTaskSettled(task).catch((err) => logger.error({ err, taskId: task.id }, "failed to notify task settled"));
    });
    // A live-updating DM progress view per task (header + activity tail, in-place edits ≤5s), with a
    // link to the full web stream. Settlement is handled by the view's own status subscription.
    dispatcher.onTaskStarted((task) => {
      if (task.spawnedFromSurface !== SURFACE) return;
      const hub = getActivityHub();
      const token = hub.tokenFor(task.id);
      const webUrl = token ? taskViewUrl(config.taskStreamBaseUrl, task.id, token) : null;
      const meta = buildTaskMeta(task, dispatcher.runnerInfo(task.runnerId));
      hub.setMeta(task.id, meta); // so the web viewer's meta panel + resume box populate
      // A resume of a still-live task reuses its existing DM view (kept alive through an idle settle) —
      // don't spawn a second message; the running activity streams into the same one.
      if (hasLiveTaskView(task.id)) return;
      void LiveTaskView.start(client, task, hub, webUrl, meta).catch((err) => logger.warn({ err, taskId: task.id }, "live task view failed"));
    });
    // Bind the ORCH port at boot so a runner reconnects immediately after any restart, rather than
    // waiting for the first dispatch to lazily bind it (which strands the runner until then).
    dispatcher.ensureListening();
    logger.info("orchestration transport listening");
    dispatcher.onRunnerStatus(({ runnerId, status }) => {
      const line = status === "connected" ? `🔌 runner \`${runnerId}\` connected` : `⚠️ runner \`${runnerId}\` disconnected`;
      void notifyOwner(line);
    });
    // Archive settled tasks idle past the TTL so the roster stays legible (still resumable).
    const archiveTtlDays = Number(process.env["TASK_ARCHIVE_TTL_DAYS"] ?? "14");
    dispatcher.archiveStaleTasks(archiveTtlDays);
    setInterval(() => dispatcher.archiveStaleTasks(archiveTtlDays), 24 * 60 * 60 * 1000);
  } catch (err) {
    if (!(err instanceof DispatcherUnavailableError)) throw err;
    logger.warn({ err }, "orchestration dispatcher unavailable; runner transport + task-settled notifications disabled");
  }

  // ── MessageCreate ────────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.guildId) {
      if (message.author.bot) return;
      // A reply to a needs_input ping is the ANSWER to that task's ask — route it, don't treat it as a
      // fresh agent message.
      if (await maybeAnswerAsk(message)) return;
      if (isOwnerDm(message, config.ownerDiscordId)) {
        await handleOwnerDm(message).catch((err) => logger.error({ err }, "unhandled error in owner DM path"));
      }
      return;
    }
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

    const baseText = buildTriggerText({
      botId: client.user.id,
      rawContent: message.content,
      emojiMap,
      authorUsername: message.author.username,
      authorId: message.author.id,
      replyContext,
      resolveBarePing: () => buildMessageContent(message),
    });

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

        // First-run guild: no server context yet. Scan the server automatically (in the background,
        // on a throwaway conversation) before answering, so the first reply already has awareness —
        // no approval prompt. Attempted at most once per guild per process, so a scan that fails
        // (e.g. missing channel-read perms) doesn't re-fire on every mention; the turn then just
        // runs with limited awareness.
        if (memory.getServerContext(guildId) === null && !scannedGuilds.has(guildId)) {
          const existing = scanningGuilds.get(guildId);
          if (existing) {
            await existing; // a concurrent mention already kicked off the scan — wait for its context
          } else {
            scannedGuilds.add(guildId);
            const p = runBackgroundScan(guildId, thread, author, channel, emojiMap, span).finally(() => scanningGuilds.delete(guildId));
            scanningGuilds.set(guildId, p);
            await p;
          }
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
      await handleWikiSyncCommand(interaction, (gid) => createDiscordWikiSyncContext(client, gid));
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
    if (btn.customId.startsWith(AUTOMOD_BTN_PREFIX) || btn.customId.startsWith(AUTOMOD_DEL_BTN_PREFIX)) {
      await handleApprovalButton(btn);
      return;
    }
    if (btn.customId.startsWith(ASK_BTN_PREFIX)) {
      await handleAskButton(btn);
      return;
    }
    if (btn.customId.startsWith(TASK_CTL_PREFIX)) {
      await handleTaskControlButton(btn);
      return;
    }
    if (btn.customId.startsWith(TASK_ANS_PREFIX)) {
      await handleAnswerButton(btn);
      return;
    }
  });

  // Route a needs_input answer (button choice or a reply) back to the parked ask_owner via the token path.
  async function answerAsk(taskId: string, text: string): Promise<boolean> {
    const token = getActivityHub().tokenFor(taskId);
    if (!token || !text) return false;
    try {
      await getDispatcher().controlByToken(taskId, token, "steer", text);
      return true;
    } catch (err) {
      logger.warn({ err, taskId }, "failed to route ask answer");
      return false;
    }
  }

  async function maybeAnswerAsk(message: Message): Promise<boolean> {
    const refId = message.reference?.messageId;
    if (!refId || !askPings.has(refId)) return false;
    const info = askPings.get(refId)!;
    const ok = await answerAsk(info.taskId, message.content.trim());
    await message.react(ok ? "✅" : "⚠️").catch(() => {});
    return true; // it was a reply to an ask ping — consumed regardless
  }

  async function handleAnswerButton(btn: ButtonInteraction): Promise<void> {
    const info = askPings.get(btn.message.id);
    if (!info) {
      await btn.reply({ content: "This question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const idx = Number.parseInt(btn.customId.slice(TASK_ANS_PREFIX.length), 10);
    const choice = info.choices[idx];
    if (choice == null) return;
    const ok = await answerAsk(info.taskId, choice);
    await btn.reply({ content: ok ? `Answered: ${choice}` : "Couldn't deliver — the task may have ended.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // Stop / Discard / Resume for a runner task, from the buttons on its live-task DM message. The DM is
  // the owner's, so the presser must be the task's creator; control goes through the token path.
  async function handleTaskControlButton(interaction: ButtonInteraction): Promise<void> {
    const rest = interaction.customId.slice(TASK_CTL_PREFIX.length);
    const sep = rest.indexOf(":");
    const action = rest.slice(0, sep);
    const taskId = rest.slice(sep + 1);
    let dispatcher;
    try {
      dispatcher = getDispatcher();
    } catch (err) {
      if (err instanceof DispatcherUnavailableError) { await interaction.reply({ content: "Runner orchestration is unavailable.", flags: MessageFlags.Ephemeral }); return; }
      throw err;
    }
    const token = getActivityHub().tokenFor(taskId);
    if (!token) { await interaction.reply({ content: "This task's live session has expired — control it via the bot instead.", flags: MessageFlags.Ephemeral }).catch(() => {}); return; }

    // Destructive discard → a confirm step (a misclick in the button row is the real risk).
    if (action === "discard") {
      const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${TASK_CTL_PREFIX}discardyes:${taskId}`).setLabel("Confirm discard").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${TASK_CTL_PREFIX}cancel:${taskId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: "Discard this task and remove its worktree? This can't be undone.", components: [confirm], flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (action === "cancel") {
      await interaction.update({ content: "Cancelled — task left as is.", components: [] }).catch(() => {});
      return;
    }

    const op = action === "discardyes" ? "discard" : action; // stop | resume | discard
    if (op !== "stop" && op !== "resume" && op !== "discard") return;
    try {
      const task = await dispatcher.controlByToken(taskId, token, op);
      const label = op === "discard" ? "Discarded — worktree removed." : op === "stop" ? "Stopped — resumable." : `Resumed (status: ${task.status}).`;
      // The confirm dialog (discardyes/cancel) is an ephemeral we own → update it; a first-level button reply is ephemeral too.
      if (action === "discardyes") await interaction.update({ content: label, components: [] }).catch(() => {});
      else await interaction.reply({ content: label, flags: MessageFlags.Ephemeral }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "control failed";
      if (action === "discardyes") await interaction.update({ content: `Failed: ${msg}`, components: [] }).catch(() => {});
      else await interaction.reply({ content: `Failed: ${msg}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

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

  /** Background server scan on a THROWAWAY conversation (`__scan__<threadId>`) so the scan turn's
   *  history + frozen threadContext never land on the real conversation. Best-effort: a failure is
   *  logged and swallowed so the triggering turn still runs (with limited awareness). */
  async function runBackgroundScan(
    guildId: string,
    thread: ThreadChannel,
    author: AuthorRef,
    channel: ChannelRef,
    emojiMap: Record<string, string>,
    span: Span,
  ): Promise<void> {
    try {
      const scanConv: ConversationRef = { surface: SURFACE, spaceId: guildId, conversationId: `__scan__${thread.id}` };
      const scanTracker = new ToolProgressTracker(thread);
      const scanSession = new DiscordSurfaceSession({
        client, thread, guildId, emojiMap, hosts: buildHosts(client, guildId), toolTracker: scanTracker,
        attachFeedback: false, channel,
      });
      const scanInbound: InboundMessage = { conversation: scanConv, author, text: SCAN_QUERY, channel };
      await runThroughCore(scanConv, thread, scanTracker, span, () => core.handleInbound(scanInbound, scanSession));
    } catch (err) {
      logger.warn({ err, guildId }, "background server scan failed (answering with limited awareness)");
    }
  }

  async function handleApprovalButton(interaction: ButtonInteraction): Promise<void> {
    const isAdd = interaction.customId.startsWith(AUTOMOD_BTN_PREFIX);
    const prefix = isAdd ? AUTOMOD_BTN_PREFIX : AUTOMOD_DEL_BTN_PREFIX;
    const rest = interaction.customId.slice(prefix.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon === -1) return;
    const threadId = rest.slice(0, lastColon);
    const decision = rest.slice(lastColon + 1); // "approve" | "reject"

    const pending = pendingApprovals.get(threadId);
    if (!pending) {
      await interaction.reply({ content: `This approval has expired — the bot was restarted. Please re-ask the agent to ${isAdd ? "add" : "remove"} the keyword.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== pending.triggeredByUserId) {
      await interaction.reply({ content: `Only <@${pending.triggeredByUserId}> can respond to this approval.`, flags: MessageFlags.Ephemeral });
      return;
    }
    pendingApprovals.delete(threadId);
    await interaction.deferUpdate();

    const { systemMessage } = await applyAutomodDecision(interaction, client, pending.action, pending.ruleId, pending.ruleName, pending.keyword, decision === "approve" ? "approve" : "reject");

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread?.isThread()) return;
    const guildId = thread.guildId;
    const guildConfig = config.guildConfig[guildId];
    if (!guildConfig) return;
    const conversation: ConversationRef = { surface: SURFACE, spaceId: guildId, conversationId: threadId };

    await withInteractionSpan("discord.interaction", { "discord.thread_id": threadId, "discord.guild_id": guildId, "discord.user_id": interaction.user.id, "discord.trigger": "approval_resume" }, async (span) => {
      const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);
      const { initialThreadContext } = store.load(conversation);
      const by = await memberAuthor(thread, interaction.user.id, guildConfig.allowedRoles);
      const channel = threadChannelRef(thread);
      const ownerSection = config.ownerDiscordId && by.userId === config.ownerDiscordId ? buildOpsTriagePromptSection() : undefined;
      const tracker = new ToolProgressTracker(thread);
      const session = new DiscordSurfaceSession({
        client, thread, guildId, emojiMap, hosts: buildHosts(client, guildId), toolTracker: tracker,
        channel, threadContext: initialThreadContext ?? undefined, threadChannelId: thread.id, ownerSection,
      });
      await runThroughCore(conversation, thread, tracker, span, () => core.resume(conversation, { kind: "approval", decision: decision === "approve" ? "approved" : "rejected", by, systemMessage }, session));
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
    void notifyOwner(`🟢 sushii-agent online — version \`${process.env["APP_VERSION"] ?? "unknown"}\``);
    await registerWikiSyncCommands(c).catch((err) => logger.error({ err }, "failed to register wiki-sync commands"));
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
