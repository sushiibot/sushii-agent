import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Message,
  type MessageCreateOptions,
  type ThreadChannel,
} from "discord.js";
import { client } from "../discordClient.ts";
import { getLogger } from "../logger.ts";
import { renderModelText } from "../utils/discordText.ts";
import { MEMORY_LIMIT } from "../db/memory.ts";
import {
  deletePendingQuestion,
  deleteStalePendingQuestions,
  loadAllPendingQuestions,
  savePendingQuestion,
} from "../db/pendingQuestions.ts";
import {
  formatToolArg,
  type AgentLoopResult,
  type AgentLoopOptions,
  type ChannelContext,
  type TriggeringUser,
  type UserNames,
} from "./loop.ts";

const logger = getLogger("delivery");

// Custom ID prefix for stop-loop button: stop:{threadId}
export const STOP_BTN_PREFIX = "stop:";
// Custom ID prefix for ask_question button interactions: agq:{threadId}:{choiceIndex}
export const ASK_BTN_PREFIX = "agq:";
// Custom ID prefix for feedback thumbs up/down buttons: fb:{threadId}:{up|down}
export const FEEDBACK_BTN_PREFIX = "fb:";

/** Builds a Components V2 container holding a single TextDisplay — the common shape for plain-text component messages. */
export function buildTextDisplayContainer(content: string): ContainerBuilder {
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder({ content }));
}

/**
 * Tracks tool calls during an agent loop iteration and displays them as a live
 * Discord message that gets edited in place. Multiple rapid calls are batched
 * together with a debounce so we don't hit rate limits.
 */
export class ToolProgressTracker {
  private msg: Message | null = null;
  private lines: string[] = [];
  private lastContent = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_MS = 500;
  private static readonly VISIBLE_LINES = 3;

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
    const hidden = this.lines.length - ToolProgressTracker.VISIBLE_LINES;
    const visible = hidden > 0 ? this.lines.slice(-ToolProgressTracker.VISIBLE_LINES) : this.lines;
    const header = hidden > 0 ? [`-# ${hidden} previous tool call${hidden === 1 ? "" : "s"}...`] : [];
    return [...header, ...visible.map((l) => `-# - ${l}`)].join("\n").slice(0, 3990);
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
    const container = buildTextDisplayContainer(this.lastContent).addActionRowComponents(stopRow);
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
      const container = buildTextDisplayContainer(this.lastContent);
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
    const container = buildTextDisplayContainer(content);
    try {
      await this.msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (err) {
      logger.warn({ err }, "failed to finalize tool progress message");
    }
  }
}

// Per-channel async mutex to prevent concurrent agent runs in the same thread
export const threadLocks = new Map<string, Promise<void>>();

// Mid-loop message injection: messages queued while an agent loop is already running
export interface MidLoopMessage {
  query: string;
  mentionedUsers: Map<string, UserNames>;
  /** Original Discord message, kept for reaction updates. */
  discordMessage: Message;
  /** Set to true by the agent loop when it injects this message — skips the fallback withThreadLock run. */
  consumed: boolean;
}
export const threadMidLoopQueues = new Map<string, MidLoopMessage[]>();
// Thread IDs where the user has requested the agent loop to stop
export const threadCancellations = new Set<string>();
// Maps threadId → userId of the user who triggered the current agent loop
export const threadTriggeringUsers = new Map<string, string>();

export function withThreadLock(threadId: string, fn: () => Promise<void>): Promise<void> {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (threadLocks.get(threadId) === next) {
      threadLocks.delete(threadId);
    }
  });
  threadLocks.set(threadId, next);
  return next;
}

export async function cleanupAgentRun(
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

export function makeDequeueMessages(threadId: string): () => { query: string; mentionedUsers?: Map<string, UserNames>; authorId: string }[] {
  return () => {
    const q = threadMidLoopQueues.get(threadId) ?? [];
    if (q.length === 0) return [];
    threadMidLoopQueues.set(threadId, []);
    for (const m of q) {
      m.consumed = true;
      m.discordMessage.reactions.cache.get("⏳")?.users.remove(client.user!.id).catch(() => {});
      m.discordMessage.react("✅").catch(() => {});
    }
    // authorId lets the loop detect when a message from someone other than the turn's original
    // triggeringUser got injected mid-loop -- see loop.ts's effectiveTriggeringUserId tainting.
    return q.map((m) => ({ query: m.query, mentionedUsers: m.mentionedUsers, authorId: m.discordMessage.author.id }));
  };
}

export async function sendQuestionWithButtons(
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
    .addTextDisplayComponents(new TextDisplayBuilder({ content: renderModelText(question, { guildId: thread.guildId }) }))
    .addActionRowComponents(row);

  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

export async function disableQuestionButtons(
  interaction: ButtonInteraction,
  question: string,
  selectedLabel: string,
): Promise<void> {
  try {
    const expandedQuestion = renderModelText(question, { guildId: interaction.guildId! });
    const container = buildTextDisplayContainer(`${expandedQuestion}\n-# Selected: ${selectedLabel}`);
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical — if we can't update the message, just continue
  }
}

export function appendFeedbackButtons(componentMsgs: MessageCreateOptions[], threadId: string): void {
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

// Max characters per TextDisplay component (Discord limit)
const TEXT_DISPLAY_MAX = 4000;
// Max top-level components per message (Discord limit)
const MAX_COMPONENTS = 40;

type RawElement = { kind: "text"; content: string } | { kind: "separator" };

export function parseElements(text: string): RawElement[] {
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

export function buildComponentMessages(text: string): MessageCreateOptions[] {
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

// In-memory map of threadId → pending question state (restored from DB on startup)
export interface PendingQuestionState {
  question: string;
  choices: string[];
  triggeredByUserId: string;
}
export const pendingChoices = new Map<string, PendingQuestionState>();

const PENDING_QUESTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Records a pending question in both the in-memory map and the DB (so buttons
 * keep working across a restart). Call alongside sendQuestionWithButtons.
 */
export function setPendingQuestion(threadId: string, state: PendingQuestionState): void {
  pendingChoices.set(threadId, state);
  savePendingQuestion({ threadId, ...state, createdAt: Date.now() });
}

/** Clears a pending question from both the in-memory map and the DB, e.g. once answered. */
export function clearPendingQuestion(threadId: string): void {
  pendingChoices.delete(threadId);
  deletePendingQuestion(threadId);
}

/**
 * Loads unanswered pending questions from the DB into the in-memory map, pruning
 * stale ones first. Called once at startup so buttons survive a restart, and again
 * hourly to re-sync (also removes in-memory entries that have gone stale since).
 */
export function restorePendingQuestions(): void {
  deleteStalePendingQuestions(PENDING_QUESTION_MAX_AGE_MS);
  const fresh = new Map<string, PendingQuestionState>();
  for (const pq of loadAllPendingQuestions()) {
    fresh.set(pq.threadId, { question: pq.question, choices: pq.choices, triggeredByUserId: pq.triggeredByUserId });
  }
  for (const key of [...pendingChoices.keys()]) {
    if (!fresh.has(key)) pendingChoices.delete(key);
  }
  for (const [key, val] of fresh) {
    pendingChoices.set(key, val);
  }
}

export function buildLoopOptions(
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
    extraOpts?: Partial<AgentLoopOptions>;
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
      const componentMsgs = buildComponentMessages(text);
      logger.child({ threadId, guildId }).debug(
        { messageCount: componentMsgs.length, content: text },
        "discord interim response sent",
      );
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
    ...opts.extraOpts,
  };
}

