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
import { SqliteConversationStore } from "../../core/stores/conversationStore.ts";
import { DiscordSpaceMemoryStore } from "../../core/stores/memoryStore.ts";
import { config, buildEmojiMap } from "../../config.ts";
import { autoModGateOpen, chatEntryGateOpen } from "../../guildConfig.ts";
import { getLogger } from "../../logger.ts";
import { getDb } from "../../db/index.ts";
import { insertMessage, updateMessageContent, softDeleteMessage, deleteOldMessages } from "../../db/messages.ts";
import { savePendingQuestion, loadPendingQuestion, deletePendingQuestion, deleteStalePendingQuestions } from "../../db/pendingQuestions.ts";
import { buildMessageContent } from "../../utils/flattenMessage.ts";
import { isPrivateChannel } from "../../tools/channelUtils.ts";
import { BEHAVIOR_INSTRUCTIONS, buildAutoModPromptSection, type AutoModTriggerContext } from "../../modules/moderation/prompt.ts";
import { guildBehavior } from "./personas.ts";
import { isAutoModEligible, checkAndSetAutoModCooldown } from "./autoModTrigger.ts";
import { registerWikiSyncCommands, handleWikiSyncCommand, WIKI_SYNC_COMMAND_NAME } from "../../modules/wiki-sync/index.ts";
import type { MakeWikiSourceContext } from "../../modules/wiki-sync/scheduler.ts";
import { createWikiFsHost } from "../../modules/wiki-sync/wikiHost.ts";
import { wikiFor } from "../../modules/wiki-sync/sources.ts";
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
import { createTranscriber } from "../../agent/transcribe.ts";
import { STOP_BTN_PREFIX, ASK_BTN_PREFIX, FEEDBACK_BTN_PREFIX, FEEDBACK_MODAL_PREFIX, AUTOMOD_BTN_PREFIX, AUTOMOD_DEL_BTN_PREFIX } from "./buttonIds.ts";
import { DM_SPACE_ID, DmConductorSession, isOwnerDm } from "./dmConductor.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import type { WorkspaceBoot } from "../../orchestration/workspace/boot.ts";
import { kvCursor, routeDirectMessage } from "../../orchestration/workspace/router.ts";
import type { OwnerDmMode } from "../../config.ts";
import { WEB_SURFACE } from "../web/actor.ts";
import { ACCENT, DiscordWorkspaceAdapter, WS_APPROVE_PREFIX, WS_ASK_PREFIX, WS_STOP_PREFIX, type DmChannelPort } from "./workspaceAdapter.ts";
import { handleWorkspaceApprovalButton, handleWorkspaceAskButton, handleWorkspaceStopButton } from "./workspaceButtons.ts";
import {
  OWNER_DM_CURSOR_KEY,
  catchUpOwnerDms,
  dispatchOwnerDm,
  createBreakGlass,
  snowflakeCursor,
  type BreakGlassReason,
  type DmCursor,
  type OwnerDmMessage,
} from "./ownerDm.ts";
import { SCREENING_IGNORE_PREFIX, handleScreeningAuditEntry, handleScreeningAutomod, handleScreeningDeletes, handleScreeningIgnore, screenDiscordMessage } from "./screening.ts";

function behaviorFor(guildId: string): string {
  return guildBehavior(config.guildConfig[guildId] ?? {});
}

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
  // The read/search/list_files tools are host-gated on `fs`: expose them only for a guild whose
  // team wiki this space reads, rooted at it.
  const wiki = wikiFor("discord", guildId);
  const fs = wiki?.reads ? createWikiFsHost(wiki.wikiId) : undefined;
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
  /** Builds the port bag for a source of the wiki a `/wiki-sync` invocation targets. Combined
   *  (Discord + Slack) so a Discord-triggered sweep of a shared wiki can build the Slack source too. */
  makeWikiSourceContext: MakeWikiSourceContext;
  /** The owner-DM adapter, built before the workspace boots. */
  workspace: DiscordWorkspace;
  boot: Pick<WorkspaceBoot, "link" | "tools" | "registry">;
  ownerDmMode: OwnerDmMode;
}

// An owner DM as the router sees it, carrying the discord.js message the in-process fallback answers.
type GatewayDm = OwnerDmMessage & { raw: Message };

export interface DiscordWorkspace {
  adapter: DiscordWorkspaceAdapter<GatewayDm>;
  /** A fixed-text, non-silent, buttonless owner DM; the web adapter calls it with the approval's nonce when
   *  its push reached no device. Deduped per nonce and rate-limited. */
  breakGlass(nonce: string, reason?: BreakGlassReason): Promise<boolean>;
}

/** The workspace's Discord adapter (the owner's DM) and the in-process DM agent it falls back to. Built
 *  before bootWorkspace, so the registry has it from the start. */
export function createDiscordWorkspace(deps: { client: Client<true>; core: AgentCore; store: SqliteConversationStore }): DiscordWorkspace {
  const { client, core, store } = deps;
  const transcriber = createTranscriber();
  // The ORCH port binds before login, so a workspace can register (and restore progress views) before
  // the client can reach the REST API.
  // Typed Client<true> for convenience, but this runs before login.
  const bootClient = client as Client;
  const clientReady = bootClient.isReady()
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        bootClient.once(Events.ClientReady, () => resolve());
        setTimeout(resolve, 60_000).unref?.();
      });
  const ownerChannel = async (): Promise<DmChannelPort | null> => {
    if (!config.ownerDiscordId) return null;
    await clientReady;
    const user = await client.users.fetch(config.ownerDiscordId).catch(() => null);
    const dm = user ? await user.createDM() : null;
    if (!dm) return null;
    return {
      send: (options) => dm.send(options),
      fetchMessage: (id) => dm.messages.fetch(id).catch(() => null),
    };
  };

  async function transcribeVoice(message: Message): Promise<string | null> {
    const att = message.attachments.first();
    const buf = att ? await fetch(att.url).then((r) => r.arrayBuffer()).catch(() => null) : null;
    return buf ? await transcriber({ data: buf, mediaType: att!.contentType ?? "audio/ogg", filename: att!.name ?? "voice-message.ogg" }) : null;
  }

  /** Owner-only in-process DM turn, used when the workspace is offline or disabled: builds a personal
   *  `spaceId` ("dm") that authz.isPersonalSpace accepts, then runs the normal core loop. Never touches
   *  the guild path. Resolves to the reply text delivered, if any. */
  async function runOwnerDmInProcess(message: Message, userText: string, notice: string | undefined): Promise<string | null> {
    if (!message.channel.isSendable()) return null;
    const channel = message.channel;
    const conversation: ConversationRef = { surface: SURFACE, spaceId: DM_SPACE_ID, conversationId: message.channelId };
    const author: AuthorRef = { surface: SURFACE, userId: message.author.id, username: message.author.username };
    const session = new DmConductorSession(
      channel,
      { id: client.user.id, username: client.user.username },
      notice ? { notice, accentColor: ACCENT.warning } : {},
    );
    const inbound: InboundMessage = { conversation, author, text: userText, sentAt: message.createdAt };

    return tracer.startActiveSpan("discord.dm", {
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
      return session.deliveredText;
    });
  }

  const adapter = new DiscordWorkspaceAdapter<GatewayDm>({
    ownerChannel,
    inbound: {
      transcribe: (dm) => transcribeVoice(dm.raw),
      runInProcess: (dm, text, { notice }) => runOwnerDmInProcess(dm.raw, text, notice),
      // Deterministic DM session boundary. A DM has no threads (unlike guilds, where each thread is a
      // fresh conversation), so this is the manual "start fresh" for the owner's one ever-growing DM.
      // A `!` prefix (not `/`) avoids triggering Discord's slash-command autocomplete/registry.
      resetInProcess: async (dm) => {
        const conversation: ConversationRef = { surface: SURFACE, spaceId: DM_SPACE_ID, conversationId: dm.channelId };
        store.save(conversation, { messages: [], initialThreadContext: null });
        await dm.react("✅").catch(() => {});
        await dm.send("Started a fresh conversation — this chat's history is cleared. Durable memory is unaffected.").catch(() => {});
      },
    },
  });
  return { adapter, breakGlass: createBreakGlass(ownerChannel) };
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
  const { client, core, store, memory, hookBus, makeWikiSourceContext } = deps;
  const discordWorkspace = deps.workspace.adapter;
  const { link: workspaceLink, tools: workspaceTools, registry: workspaceSurfaces } = deps.boot;
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

  const dmCursor: DmCursor = kvCursor(new WorkspaceLinkStore(getDb()), OWNER_DM_CURSOR_KEY);

  function ownerDmMessage(message: Message): GatewayDm | null {
    if (!message.channel.isSendable()) return null;
    const channel = message.channel;
    return {
      raw: message,
      id: message.id,
      channelId: message.channelId,
      content: message.content,
      author: { id: message.author.id, name: message.author.globalName ?? message.author.username },
      isVoice: message.flags.has(MessageFlags.IsVoiceMessage),
      attachments: [...message.attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType ?? "application/octet-stream" })),
      react: (emoji) => message.react(emoji),
      send: (options) => channel.send(options),
    };
  }

  // Owner DMs handled since startup, until catch-up has run; null afterwards.
  let handledBeforeCatchUp: Set<string> | null = new Set();

  async function handleOwnerDm(message: Message): Promise<void> {
    const dm = ownerDmMessage(message);
    if (!dm) return;
    await dispatchOwnerDm(dm, {
      mode: deps.ownerDmMode,
      webUp: () => workspaceSurfaces.get(WEB_SURFACE) !== undefined,
      workspaceEnabled: config.dmWorkspaceEnabled,
      transcriptionEnabled: config.transcriptionEnabled,
      link: workspaceLink,
      surface: discordWorkspace,
      cursor: dmCursor,
    });
  }

  /** Replays owner DMs sent while the bot was down. The workspace dedupes by message id. */
  async function catchUpOwnerDmsOnReady(cursor: string | null): Promise<void> {
    if (deps.ownerDmMode === "redirect" || !config.dmWorkspaceEnabled || !config.ownerDiscordId) return;
    const ownerId = config.ownerDiscordId;
    // The workspace reconnects with backoff after a bot restart; give it a moment so caught-up DMs
    // don't all land on the offline fallback.
    await workspaceLink.waitForConnection(15_000);
    const user = await client.users.fetch(ownerId).catch(() => null);
    const dmChannel = user ? await user.createDM().catch(() => null) : null;
    if (!dmChannel) return;
    const handled = handledBeforeCatchUp ?? new Set<string>();
    const count = await catchUpOwnerDms({
      cursor,
      ownerId,
      now: Date.now(),
      fetchAfter: async (after, limit) => [...(await dmChannel.messages.fetch({ after, limit, cache: false })).values()],
      handle: (m) => handleDirectMessage(m),
      alreadyHandled: (id) => handled.has(id),
    });
    if (count > 0) logger.info({ count }, "caught up owner DMs sent while offline");
  }

  /** Live and caught-up DMs alike go through the owner-DM router. */
  async function handleDirectMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    await routeDirectMessage(message, {
      isOwner: isOwnerDm(message, config.ownerDiscordId),
      handleOwner: handleOwnerDm,
      cursor: snowflakeCursor(dmCursor),
      onOwnerDm: (id) => handledBeforeCatchUp?.add(id),
    });
  }

  /** Owner-only ops notice (startup). Best-effort — a failed DM never
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

  // ── MessageCreate ────────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.guildId) {
      await handleDirectMessage(message).catch((err) => logger.error({ err }, "unhandled error in DM path"));
      return;
    }
    const guildConfig = config.guildConfig[message.guildId];
    if (!guildConfig) return;
    const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

    // Cache every message from configured guilds, including bots.
    insertMessage(message);
    if (message.author.bot) return;
    // Before the auto-mod branch, which returns early.
    screenDiscordMessage(client, message as Message<true>);

    // Auto-mod trigger: mod role pinged by an authorized role (no bot mention required).
    if (autoModGateOpen(guildConfig, isAutoModEligible(message, guildConfig))) {
      if (!checkAndSetAutoModCooldown(message.guildId, message.channelId, guildConfig)) {
        logger.debug({ guildId: message.guildId, channelId: message.channelId }, "auto-mod trigger suppressed by cooldown");
        return;
      }
      void handleAutoModTrigger(message, message.guildId, emojiMap);
      return;
    }

    // Conversational entry gate: guild configured (checked above) + mention/reply + sender holds an
    // allowedRoles role. Independent of enabledModules — moderation only gates moderation features.
    const isMention = message.mentions.has(client.user.id);
    const isReply = !isMention && (await isReplyToBot(message, client.user.id));
    if (!chatEntryGateOpen(guildConfig, { isMention, isReply, memberRoleIds: message.member ? [...message.member.roles.cache.keys()] : null })) return;

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
          moduleExtras: undefined,
          behavior: behaviorFor(guildId),
        });

        const inbound: InboundMessage = {
          conversation,
          author,
          text: turnText,
          sentAt: message.createdAt,
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
            sentAt: message.createdAt,
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
      await handleWikiSyncCommand(interaction, makeWikiSourceContext);
      return;
    }
    if (!interaction.isButton()) return;
    const btn = interaction as ButtonInteraction;

    if (btn.customId.startsWith(STOP_BTN_PREFIX)) {
      await handleStopButton(btn);
      return;
    }
    if (btn.customId.startsWith(SCREENING_IGNORE_PREFIX)) {
      await handleScreeningIgnore(client, btn);
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
    if (btn.customId.startsWith(WS_STOP_PREFIX)) {
      await handleWorkspaceStopButton(btn, { link: workspaceLink });
      return;
    }
    if (btn.customId.startsWith(WS_ASK_PREFIX)) {
      await handleWorkspaceAskButton(btn, { link: workspaceLink });
      return;
    }
    if (btn.customId.startsWith(WS_APPROVE_PREFIX)) {
      await handleWorkspaceApprovalButton(btn, { tools: workspaceTools });
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
        behavior: behaviorFor(guildId),
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
        attachFeedback: false, channel, behavior: behaviorFor(guildId),
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
      const tracker = new ToolProgressTracker(thread);
      const session = new DiscordSurfaceSession({
        client, thread, guildId, emojiMap, hosts: buildHosts(client, guildId), toolTracker: tracker,
        channel, threadContext: initialThreadContext ?? undefined, threadChannelId: thread.id,
        behavior: behaviorFor(guildId),
      });
      await runThroughCore(conversation, thread, tracker, span, () => core.resume(conversation, { kind: "approval", decision: decision === "approve" ? "approved" : "rejected", by, systemMessage }, session));
    });
  }

  // ── Message cache lifecycle ─────────────────────────────────────────────────
  client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
    if (!newMsg.guildId || newMsg.partial) return;
    updateMessageContent(newMsg.id, buildMessageContent(newMsg as Message), newMsg.editedTimestamp ?? Date.now());
    // Unfurled embeds arrive as an update with unchanged content: only the image checks need rerunning.
    const contentChanged = oldMsg.partial || oldMsg.content !== newMsg.content;
    if (!newMsg.author.bot) screenDiscordMessage(client, newMsg as Message<true>, { skipText: !contentChanged });
  });
  client.on(Events.MessageDelete, (message) => {
    if (!message.guildId) return;
    softDeleteMessage(message.id);
    handleScreeningDeletes(client, message.guildId, [message.id]);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    handleScreeningDeletes(client, channel.guildId, [...messages.keys()]);
  });
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => handleScreeningAuditEntry(client, entry, guild));
  client.on(Events.AutoModerationActionExecution, (execution) => handleScreeningAutomod(client, execution));

  client.once(Events.ClientReady, async (c) => {
    // Read before any await: a live DM handled meanwhile would move the stored cursor past the backlog.
    const dmCursorAtReady = dmCursor.get();
    logger.info({ tag: c.user.tag }, "Logged in");
    logger.info({ guilds: Object.keys(config.guildConfig) }, "Watching guilds");
    void notifyOwner(`🟢 sushii-agent online — version \`${process.env["APP_VERSION"] ?? "unknown"}\``);
    await registerWikiSyncCommands(c).catch((err) => logger.error({ err }, "failed to register wiki-sync commands"));
    await catchUpOwnerDmsOnReady(dmCursorAtReady).catch((err) => logger.error({ err }, "owner DM catch-up failed"));
    handledBeforeCatchUp = null;
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
