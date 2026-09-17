import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type Client,
  type MessageCreateOptions,
  type ThreadChannel,
} from "discord.js";
import type {
  AgentReply,
  ChannelRef,
  ConversationRef,
  PendingInteraction,
  ReplySegment,
  SurfaceCapabilities,
  SurfaceSession,
  ToolHosts,
  TurnPromptContext,
} from "../../core/contracts.ts";
import { ASK_BTN_PREFIX, FEEDBACK_BTN_PREFIX } from "./buttonIds.ts";
import { appendFeedbackButtons, buildComponentMessages, buildTextDisplayContainer, ToolProgressTracker } from "./delivery.ts";
import { buildApprovalContainer } from "./approvals.ts";
import { renderFooter } from "./footer.ts";
import { DiscordPlatformRenderer } from "./render.ts";

const DISCORD_CAPABILITIES: SurfaceCapabilities = {
  richComponents: true,
  customEmoji: true,
  nativeTimestamps: true,
  threads: true,
  reactions: true,
  progress: true,
  interactiveChoices: true,
  typing: true,
  replyTo: true,
};

function segmentsToText(segments: ReplySegment[], renderer: DiscordPlatformRenderer, guildId: string, emojiMap?: Record<string, string>): string {
  return segments
    .map((s) => (s.kind === "separator" ? "\n---\n" : renderer.renderText(s.text, { spaceId: guildId, emojiMap })))
    .join("");
}

export interface DiscordSurfaceSessionOptions {
  client: Client<true>;
  thread: ThreadChannel;
  guildId: string;
  emojiMap?: Record<string, string>;
  hosts: ToolHosts;
  toolTracker?: ToolProgressTracker;
  /** Attach feedback thumbs to the final message of a completed (non-interim) turn. */
  attachFeedback?: boolean;
  /** Per-turn prompt inputs the core folds into slot assembly (contracts.ts §6, C8). */
  channel?: ChannelRef;
  threadContext?: string;
  threadChannelId?: string;
  ownerSection?: string;
  moduleExtras?: string[];
}

export class DiscordSurfaceSession implements SurfaceSession {
  readonly capabilities = DISCORD_CAPABILITIES;
  readonly renderer = new DiscordPlatformRenderer();
  readonly selfId: string;
  readonly selfName: string;
  readonly hosts: ToolHosts;

  private cancelled = false;
  private readonly thread: ThreadChannel;
  private readonly guildId: string;
  private readonly emojiMap?: Record<string, string>;
  private readonly toolTracker?: ToolProgressTracker;
  private readonly attachFeedback: boolean;
  private readonly promptInputs: TurnPromptContext;

  constructor(opts: DiscordSurfaceSessionOptions) {
    this.selfId = opts.client.user.id;
    this.selfName = opts.client.user.username;
    this.thread = opts.thread;
    this.guildId = opts.guildId;
    this.emojiMap = opts.emojiMap;
    this.hosts = opts.hosts;
    this.toolTracker = opts.toolTracker;
    this.attachFeedback = opts.attachFeedback ?? true;
    this.promptInputs = {
      channel: opts.channel,
      emojiMap: opts.emojiMap,
      threadContext: opts.threadContext,
      threadChannelId: opts.threadChannelId,
      ownerSection: opts.ownerSection,
      moduleExtras: opts.moduleExtras,
    };
  }

  promptContext(): TurnPromptContext {
    return this.promptInputs;
  }

  async deliver(reply: AgentReply): Promise<{ messageId?: string }> {
    await this.toolTracker?.reset();

    const text = segmentsToText(reply.segments, this.renderer, this.guildId, this.emojiMap);
    const footer = renderFooter(reply.usage, this.toolTracker ? [] : reply.toolTrace);
    const full = footer ? (text ? `${text}\n${footer}` : footer) : text;
    if (!full) return {};

    const componentMsgs: MessageCreateOptions[] = buildComponentMessages(full);
    if (this.attachFeedback && !reply.stoppedEarly) {
      appendFeedbackButtons(componentMsgs, this.thread.id, FEEDBACK_BTN_PREFIX);
    }

    let lastId: string | undefined;
    for (const msg of componentMsgs) {
      const sent = await this.thread.send({ ...msg, allowedMentions: { parse: [] } });
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  async presentInteraction(pending: PendingInteraction): Promise<void> {
    if (pending.kind === "question") {
      const { question, choices } = pending.payload;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        choices.map((label, i) => {
          const safeLabel = label.length > 80 ? `${label.slice(0, 77)}...` : label;
          return new ButtonBuilder()
            .setCustomId(`${ASK_BTN_PREFIX}${this.thread.id}:${i}`)
            .setLabel(safeLabel)
            .setStyle(ButtonStyle.Primary);
        }),
      );
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder({ content: this.renderer.renderText(question, { spaceId: this.guildId, emojiMap: this.emojiMap }) }))
        .addActionRowComponents(row);
      await this.thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
      return;
    }

    const container = buildApprovalContainer(this.thread.id, pending.payload);
    await this.thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  requestCancel(): void {
    this.cancelled = true;
  }

  async setStatus(content: string): Promise<void> {
    await this.thread.send({ components: [buildTextDisplayContainer(`-# ${content}`)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
  }
}

export function conversationRefForThread(surface: "discord", guildId: string, threadId: string): ConversationRef {
  return { surface, spaceId: guildId, conversationId: threadId };
}
