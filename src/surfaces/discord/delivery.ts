import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Message,
  type MessageCreateOptions,
  type ThreadChannel,
} from "discord.js";
import { getLogger } from "../../logger.ts";
import { STOP_BTN_PREFIX } from "./buttonIds.ts";
import { formatToolArg } from "./footer.ts";

const logger = getLogger("surfaces/discord/delivery");

// Max characters per TextDisplay component (Discord limit)
const TEXT_DISPLAY_MAX = 4000;
// Max top-level components per message (Discord limit)
const MAX_COMPONENTS = 40;

type RawElement = { kind: "text"; content: string } | { kind: "separator" };

export function buildTextDisplayContainer(content: string): ContainerBuilder {
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder({ content }));
}

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

export function appendFeedbackButtons(componentMsgs: MessageCreateOptions[], threadId: string, feedbackBtnPrefix: string): void {
  if (componentMsgs.length === 0) return;
  const lastMsg = componentMsgs[componentMsgs.length - 1];
  const container = lastMsg.components?.[0] as ContainerBuilder | undefined;
  if (!container) return;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${feedbackBtnPrefix}${threadId}:up`)
      .setLabel("👍 Helpful")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${feedbackBtnPrefix}${threadId}:down`)
      .setLabel("👎 Not Helpful")
      .setStyle(ButtonStyle.Secondary),
  );

  container
    .addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }))
    .addActionRowComponents(row);
}

/**
 * Tracks tool calls during an agent turn and displays them as a live Discord message
 * that gets edited in place. Rapid calls are batched with a debounce to avoid rate limits.
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

  /** Flush pending updates, remove the stop button, and reset state for the next batch. */
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
