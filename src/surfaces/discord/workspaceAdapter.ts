// The Discord surface of the personal-agent workspace: renders the core's structured views as
// Components V2 messages in the owner's DM, and answers the owner's DMs with reactions and notices.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import type { ChatDeliverParams, ChatOrigin, ToolCallResult } from "../../orchestration/contracts.ts";
import { deliveryView } from "../../orchestration/workspace/link.ts";
import { formatDuration, toolsLabel } from "../../orchestration/workspace/progress.ts";
import { NONCE_RE } from "../../orchestration/workspace/tools.ts";
import {
  SurfaceUnavailableError,
  type AckKind,
  type ApprovalDecision,
  type ApprovalField,
  type ApprovalView,
  type AskView,
  type InboundMessage,
  type InboundSurface,
  type PageLedger,
  type ProgressFinal,
  type ProgressView,
  type ReplyView,
  type RouterNotice,
  type SendAttempt,
  type SurfaceAdapter,
  type SurfaceCapabilities,
  type SurfaceMessageHandle,
} from "../../orchestration/workspace/surface.ts";
import { buildComponentMessages } from "./delivery.ts";
import { renderChatUsageFooter } from "./footer.ts";
import type { OwnerDmMessage } from "./ownerDm.ts";

export const DISCORD_SURFACE = "discord";

export const WS_STOP_PREFIX = "wsstop:";
export const WS_ASK_PREFIX = "wsask:";
export const WS_APPROVE_PREFIX = "wsap:";

export const ACCENT = { info: 0x5865f2, success: 0x23a55a, danger: 0xf23f43, warning: 0xf0b232 } as const;

export const OFFLINE_NOTICE = "-# ⚠️ workspace offline — answering without workspace tools";
export const NEW_WHILE_OFFLINE = "-# ⚠️ workspace offline — its session is unchanged; send `!new` again once it's back";

const PROGRESS_LINES = 8;
const PLAIN_CHUNK = 2000;
const ASK_QUESTION_MAX = 3500;
const ASK_CHOICES_MAX = 25;
const RESULT_SUMMARY_MAX = 200;
const AGENT_NAME_MAX = 64;

export const DISCORD_CAPABILITIES: SurfaceCapabilities = { streaming: false, tables: false, richButtons: true, reactions: true, maxMessageChars: 4000 };

const ACK_EMOJI: Record<AckKind, string> = {
  accepted: "👀",
  steer: "↪️",
  queued: "⏳",
  newSession: "🧠",
  stopped: "⏹️",
  transcribing: "🎙️",
};

export interface EditableMessage {
  /** Needed to find a progress message again after a restart; without it the view isn't persisted. */
  id?: string;
  edit(options: MessageEditOptions): Promise<unknown>;
}

export interface DmChannelPort {
  send(options: MessageCreateOptions): Promise<EditableMessage>;
  /** Re-opens a message this bot sent earlier; resolves null when it's gone. */
  fetchMessage?(id: string): Promise<EditableMessage | null>;
}

/** An owner DM as the core sees it, carrying the Discord message it answers. */
export type DiscordInbound<P extends OwnerDmMessage = OwnerDmMessage> = InboundMessage & { port: P };

export function discordInbound<P extends OwnerDmMessage>(port: P): DiscordInbound<P> {
  return {
    origin: { surface: DISCORD_SURFACE, conversationId: port.channelId },
    id: port.id,
    text: port.content,
    author: port.author,
    isVoice: port.isVoice,
    attachments: port.attachments,
    port,
  };
}

/** The in-process pieces behind an owner DM; the gateway supplies the real ones. */
export interface DiscordInboundDeps<P extends OwnerDmMessage = OwnerDmMessage> {
  transcribe(message: P): Promise<string | null>;
  /** Runs the in-process DM agent; resolves to the reply text it delivered, if any. */
  runInProcess(message: P, text: string, options: { notice?: string }): Promise<string | null>;
  /** The in-process `!new`: clears the DM conversation history. */
  resetInProcess(message: P): Promise<void>;
}

export function voiceEcho(transcript: string): string {
  return `-# 🎙️ ${transcript}`;
}

function newSessionReply(): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(ACCENT.success).addTextDisplayComponents(new TextDisplayBuilder({ content: "✅ New session." }));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

function noticeMessage(notice: RouterNotice): string | MessageCreateOptions {
  switch (notice.type) {
    case "newSessionStarted":
      return newSessionReply();
    case "newSessionFailed":
      return `Couldn't start a new session: ${notice.error}`;
    case "newWhileOffline":
      return NEW_WHILE_OFFLINE;
    case "nothingToStop":
      return "-# ⚠️ workspace offline — nothing to stop";
    case "stopFailed":
      return `Couldn't stop: ${notice.error}`;
    case "transcriptionFailed":
      return "Sorry, I couldn't transcribe that voice message.";
    case "transcript":
      return voiceEcho(notice.text);
  }
}

/** Answers an owner DM in place: reactions on it, notices in its channel, the in-process fallback agent. */
export class DiscordOwnerDmSurface<P extends OwnerDmMessage = OwnerDmMessage> implements InboundSurface<DiscordInbound<P>> {
  constructor(protected readonly inbound: DiscordInboundDeps<P>) {}

  async ack(message: DiscordInbound<P>, kind: AckKind): Promise<void> {
    await message.port.react(ACK_EMOJI[kind]);
  }

  async notice(message: DiscordInbound<P>, notice: RouterNotice): Promise<void> {
    await message.port.send(noticeMessage(notice));
  }

  transcribe(message: DiscordInbound<P>): Promise<string | null> {
    return this.inbound.transcribe(message.port);
  }

  fallbackReply(message: DiscordInbound<P>, text: string, opts: { offline: boolean }): Promise<string | null> {
    return this.inbound.runInProcess(message.port, text, opts.offline ? { notice: OFFLINE_NOTICE } : {});
  }

  resetFallback(message: DiscordInbound<P>): Promise<void> {
    return this.inbound.resetInProcess(message.port);
  }
}

const NO_INBOUND: DiscordInboundDeps = {
  transcribe: async () => null,
  runInProcess: async () => null,
  resetInProcess: async () => {},
};

/** The workspace's Discord adapter. Everything goes to the owner's DM: it is the only Discord
 *  conversation a principal has, so an origin's conversationId isn't consulted. */
export class DiscordWorkspaceAdapter<P extends OwnerDmMessage = OwnerDmMessage> extends DiscordOwnerDmSurface<P> implements SurfaceAdapter<DiscordInbound<P>> {
  readonly surface = DISCORD_SURFACE;
  readonly capabilities = DISCORD_CAPABILITIES;
  private readonly ownerChannel: () => Promise<DmChannelPort | null>;

  constructor(opts: { ownerChannel: () => Promise<DmChannelPort | null>; inbound?: DiscordInboundDeps<P> }) {
    super(opts.inbound ?? (NO_INBOUND as DiscordInboundDeps<P>));
    this.ownerChannel = opts.ownerChannel;
  }

  private async channel(): Promise<DmChannelPort> {
    const channel = await this.ownerChannel().catch(() => null);
    if (!channel) throw new SurfaceUnavailableError("owner DM unavailable");
    return channel;
  }

  async sendReply(_origin: ChatOrigin | null, reply: ReplyView, attempt: SendAttempt): Promise<void> {
    const channel = await this.channel();
    if (!attempt.plain) {
      await sendPages(channel, renderReplyPages(reply), attempt.ledger);
      return;
    }
    let pages: MessageCreateOptions[] | null = null;
    try {
      pages = renderReplyPages(reply);
    } catch {
      pages = null;
    }
    // Pages that already went out as components aren't repeated.
    await sendPlain(channel, pages && pages.length > 1 ? unsentPagesText(pages, attempt.ledger) : reply.text);
  }

  async askPrompt(_origin: ChatOrigin | null, ask: AskView, attempt: SendAttempt): Promise<void> {
    const channel = await this.channel();
    if (attempt.plain) await sendPlain(channel, ask.question);
    else await channel.send(renderAsk(ask));
  }

  async progressCreate(_origin: ChatOrigin | null, view: ProgressView): Promise<SurfaceMessageHandle> {
    return (await this.channel()).send(renderWorking(view));
  }

  async progressUpdate(handle: SurfaceMessageHandle, view: ProgressView): Promise<void> {
    await (handle as EditableMessage).edit(renderWorking(view));
  }

  async progressFinalize(_origin: ChatOrigin | null, handle: SurfaceMessageHandle | null, final: ProgressFinal): Promise<void> {
    if (handle) await (handle as EditableMessage).edit(renderProgressFinal(final));
    else await (await this.channel()).send(renderProgressFinal(final));
  }

  async progressReopen(_origin: ChatOrigin | null, id: string): Promise<SurfaceMessageHandle | null> {
    const channel = await this.ownerChannel().catch(() => null);
    return (await channel?.fetchMessage?.(id).catch(() => null)) ?? null;
  }

  async approvalPrompt(_origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<SurfaceMessageHandle> {
    return (await this.channel()).send(renderApprovalPrompt(nonce, view));
  }

  async resolveApproval(handle: SurfaceMessageHandle, view: ApprovalView, nonce: string, decision: ApprovalDecision, result?: ToolCallResult): Promise<void> {
    await (handle as EditableMessage).edit(renderApprovalFinal(nonce, view, decision, result));
  }
}

async function sendPages(channel: DmChannelPort, pages: MessageCreateOptions[], ledger: PageLedger): Promise<void> {
  for (const [i, page] of pages.entries()) {
    if (pages.length > 1 && ledger.isSent(i)) continue;
    await channel.send(page);
    if (pages.length > 1) ledger.markSent(i);
  }
}

async function sendPlain(channel: DmChannelPort, text: string): Promise<void> {
  for (const chunk of plainChunks(text)) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

function unsentPagesText(pages: MessageCreateOptions[], ledger: PageLedger): string {
  return pages
    .filter((_, i) => !ledger.isSent(i))
    .map((page) => textDisplays(page.components ?? []).join("\n"))
    .join("\n");
}

function plainChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += PLAIN_CHUNK) chunks.push(text.slice(i, i + PLAIN_CHUNK));
  return chunks.length ? chunks : ["(empty message)"];
}

/** The text display contents of a message's components, in order. */
function textDisplays(components: readonly unknown[]): string[] {
  const texts: string[] = [];
  const walk = (node: unknown) => {
    const n = node as { type?: number; content?: unknown; components?: unknown[] };
    if (n?.type === ComponentType.TextDisplay && typeof n.content === "string") texts.push(n.content);
    n?.components?.forEach(walk);
  };
  for (const c of components) walk(typeof (c as { toJSON?: unknown }).toJSON === "function" ? (c as { toJSON(): unknown }).toJSON() : c);
  return texts;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderReplyPages(reply: ReplyView): MessageCreateOptions[] {
  const prefix = reply.kind === "proactive" ? "-# ⏰\n" : "";
  const tools = reply.toolCount ? toolsLabel(reply.toolCount) : null;
  const footerLine = reply.usage ? `${renderChatUsageFooter(reply.usage)}${tools ? ` · ${tools}` : ""}` : tools ? `-# ${tools}` : null;
  const footer = footerLine ? `\n${footerLine}` : "";
  return buildComponentMessages(`${prefix}${reply.text}${footer}`).map((m) => ({ ...m, allowedMentions: { parse: [] } }));
}

export function renderAsk(ask: AskView): MessageCreateOptions {
  const question = ask.question.length > ASK_QUESTION_MAX ? `${ask.question.slice(0, ASK_QUESTION_MAX)}…` : ask.question;
  const choices = ask.choices.slice(0, ASK_CHOICES_MAX);
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.info)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `🙋 **Question**\n${question}\n-# ${choices.length ? "Pick an option or reply here." : "Reply here to answer."}` }));
  if (ask.askId !== null && choices.length) {
    for (let i = 0; i < choices.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      choices.slice(i, i + 5).forEach((choice, j) =>
        row.addComponents(new ButtonBuilder().setCustomId(`${WS_ASK_PREFIX}${ask.askId}:${i + j}`).setLabel(choice.slice(0, 80)).setStyle(ButtonStyle.Secondary)),
      );
      container.addActionRowComponents(row);
    }
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** A delivery as the Discord messages it becomes. */
export function renderDelivery(p: ChatDeliverParams, toolCount: number | null = null): MessageCreateOptions[] {
  const d = deliveryView(p, toolCount);
  return d.type === "ask" ? [renderAsk(d.view)] : renderReplyPages(d.view);
}

export function renderWorking(view: Pick<ProgressView, "turnId" | "startedAt" | "lines">): MessageCreateOptions & MessageEditOptions {
  const icon = { run: "…", ok: "✓", err: "✗" } as const;
  const lines = view.lines.slice(-PROGRESS_LINES).map((l) => `${l.agentId ? "↳ " : ""}${icon[l.state]} \`${l.name}\` ${l.summary}`.trimEnd());
  const header = `-# ⏳ working · started <t:${Math.floor(view.startedAt / 1000)}:R>`;
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.info)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: [header, ...lines].join("\n") }))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${WS_STOP_PREFIX}${view.turnId}`).setLabel("Stop").setStyle(ButtonStyle.Secondary)),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

export function renderProgressFinal(final: ProgressFinal): MessageCreateOptions & MessageEditOptions {
  const summary = final.summary ? ` · ${formatDuration(final.summary.durationMs)} · ${toolsLabel(final.summary.toolCount)}` : "";
  const [label, accent] =
    final.outcome === "done"
      ? [`✓ done${summary}`, ACCENT.info]
      : final.outcome === "stopped"
        ? [`⏹ stopped${summary}`, ACCENT.danger]
        : [`⚠️ interrupted${summary}`, ACCENT.warning];
  const container = new ContainerBuilder().setAccentColor(accent).addTextDisplayComponents(new TextDisplayBuilder({ content: label }));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** The ask message once answered: its question text with the choice noted, and no buttons. */
export function answeredAsk(message: { components: Array<{ toJSON(): unknown }> }, answer: string): MessageEditOptions {
  const texts = textDisplays(message.components);
  const question = (texts[0] ?? "🙋 **Question**").split("\n-# ")[0];
  const container = new ContainerBuilder().setAccentColor(ACCENT.success).addTextDisplayComponents(new TextDisplayBuilder({ content: `${question}\n-# → ${answer}` }));
  return { components: [container], allowedMentions: { parse: [] } };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Inline text that can't open a new line (so no line-start headers, subtext or quotes) or carry live
 *  markdown, links, mentions or timestamps. */
function inlineSafe(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return escapeMarkdown(flat, { maskedLink: true }).replace(/[<>@]/g, (c) => `\\${c}`);
}

/** Text rendered verbatim inside a code block: backticks are swapped so it can't close the block. */
function codeBlockSafe(text: string): string {
  return text.replace(/`/g, "ˋ");
}

/** At most `max` UTF-16 units of `text`, never splitting a surrogate pair. */
function clipAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const cp of text) {
    if (end + cp.length > max) break;
    end += cp.length;
  }
  return text.slice(0, end);
}

/** The approval prompt's args lines, in the fields' order. */
export function renderApprovalArgs(fields: readonly ApprovalField[]): string {
  return fields
    .map((f) => {
      if (f.kind === "single") return `**${f.key}:** ${inlineSafe(f.value)}`;
      const shown = clipAtCodePoint(f.value, f.max);
      const extra = shown.length < f.value.length ? `\n-# (+${f.value.length - shown.length} more chars)` : "";
      return `**${f.key}:**\n\`\`\`\n${codeBlockSafe(shown)}\n\`\`\`${extra}`;
    })
    .join("\n");
}

// agentId is self-reported by the workspace, so the subagent label is advisory.
function requesterLine(view: ApprovalView): string {
  const name = clip(view.agentName.replace(/\s+/g, " ").trim(), AGENT_NAME_MAX).replace(/`/g, "'") || "?";
  return `**${view.tool}** requested by \`${name}\`${view.agentId !== "main" ? " (subagent of main)" : ""}`;
}

function approvalButtons(nonce: string, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${WS_APPROVE_PREFIX}${nonce}:approve`).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${WS_APPROVE_PREFIX}${nonce}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function approvalBody(view: ApprovalView): string {
  return [requesterLine(view), renderApprovalArgs(view.fields)].filter(Boolean).join("\n");
}

export function renderApprovalPrompt(nonce: string, view: ApprovalView): MessageCreateOptions {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.warning)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `### 🙋 Approve action?\n${approvalBody(view)}\n-# auto-denies in 30 min` }))
    .addActionRowComponents(approvalButtons(nonce, false));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

export function renderApprovalFinal(nonce: string, view: ApprovalView, decision: ApprovalDecision, result?: ToolCallResult): MessageEditOptions {
  const header = { approve: "✅ Approved", deny: "❌ Denied", timeout: "⌛ Timed out", expired: "⌛ Expired (workspace disconnected)" }[decision];
  const outcome = result ? `\n-# → ${inlineSafe(clip((result.ok ? result.result : `failed: ${result.error}`).split("\n")[0] ?? "", RESULT_SUMMARY_MAX))}` : "";
  const container = new ContainerBuilder()
    .setAccentColor(decision === "approve" ? ACCENT.success : ACCENT.danger)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `### ${header}\n${approvalBody(view)}${outcome}` }))
    .addActionRowComponents(approvalButtons(nonce, true));
  return { components: [container], allowedMentions: { parse: [] } };
}

/** Parses `wsap:<nonce>:<approve|deny>`. Anything else, including the older callId-based ids, is null. */
export function parseApprovalId(customId: string): { nonce: string; decision: "approve" | "deny" } | null {
  if (!customId.startsWith(WS_APPROVE_PREFIX)) return null;
  const [nonce, decision, ...rest] = customId.slice(WS_APPROVE_PREFIX.length).split(":");
  if (rest.length || !nonce || !NONCE_RE.test(nonce)) return null;
  if (decision !== "approve" && decision !== "deny") return null;
  return { nonce, decision };
}
