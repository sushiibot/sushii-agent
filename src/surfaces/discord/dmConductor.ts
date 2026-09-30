// Owner-only DM conductor: the SurfaceSession + gate for the owner's in-process DM turns (the
// fallback when the workspace is offline). `DM_SPACE_ID` MUST match authz.ts's PERSONAL_SPACES key
// exactly (spaceKey("discord", DM_SPACE_ID) === "discord:dm").
import { PERSONAL_BEHAVIOR } from "./personas.ts";
import type { ContainerBuilder, MessageCreateOptions } from "discord.js";
import type { AgentReply, SurfaceCapabilities, SurfaceSession, ToolHosts, TurnPromptContext } from "../../core/contracts.ts";
import { buildComponentMessages } from "./delivery.ts";
import { renderFooter } from "./footer.ts";
import { DiscordPlatformRenderer } from "./render.ts";

export const DM_SPACE_ID = "dm";

/** Only the configured owner's own (non-bot) DMs are handled — everyone else is ignored exactly
 *  like today's `if (!message.guildId) return;`, so the bot never converses in a random DM. */
export function isOwnerDm(message: { author: { bot: boolean; id: string } }, ownerDiscordId: string | undefined): boolean {
  if (!ownerDiscordId) return false;
  if (message.author.bot) return false;
  return message.author.id === ownerDiscordId;
}

const DM_CAPABILITIES: SurfaceCapabilities = {
  richComponents: true,
  customEmoji: false,
  nativeTimestamps: true,
  threads: false,
  reactions: false,
  progress: false,
  // No presentInteraction here — a paused turn (ask_question/approval) would deadlock, so this stays
  // off rather than half-implementing resume UX.
  interactiveChoices: false,
  typing: false,
  replyTo: false,
};

interface SendableChannel {
  send(options: MessageCreateOptions): Promise<{ id: string }>;
}

/** Minimal SurfaceSession for the owner-DM conductor turn — deliberately NOT DiscordSurfaceSession,
 *  which is thread/guild-shaped (ContainerBuilder feedback buttons, tool-progress tracker tied to a
 *  ThreadChannel). A DM has no thread/guild, so this reuses only the plain render+send helpers. */
export class DmConductorSession implements SurfaceSession {
  readonly capabilities = DM_CAPABILITIES;
  readonly renderer = new DiscordPlatformRenderer();
  readonly selfId: string;
  readonly selfName: string;
  readonly hosts: ToolHosts = {};
  /** Reply text of the last deliver() (without footer or notice). */
  deliveredText: string | null = null;
  private readonly notice: string | undefined;
  private readonly accentColor: number | undefined;

  constructor(
    private readonly channel: SendableChannel,
    self: { id: string; username: string },
    /** A subtext line prepended to the reply, e.g. the workspace-offline note. */
    options: { notice?: string; accentColor?: number } = {},
  ) {
    this.selfId = self.id;
    this.selfName = self.username;
    this.notice = options.notice;
    this.accentColor = options.accentColor;
  }

  // Only the owner reaches this session (isOwnerDm).
  promptContext(): TurnPromptContext {
    return { behavior: PERSONAL_BEHAVIOR };
  }

  async deliver(reply: AgentReply): Promise<{ messageId?: string }> {
    const text = reply.segments
      .map((s) => (s.kind === "separator" ? "\n---\n" : this.renderer.renderText(s.text, { spaceId: DM_SPACE_ID })))
      .join("");
    this.deliveredText = text;
    const footer = renderFooter(reply.usage, reply.toolTrace);
    const body = footer ? (text ? `${text}\n${footer}` : footer) : text;
    if (!body) return {};
    const full = this.notice ? `${this.notice}\n${body}` : body;

    let lastId: string | undefined;
    const messages = buildComponentMessages(full);
    if (this.accentColor !== undefined) (messages[0]?.components?.[0] as ContainerBuilder | undefined)?.setAccentColor(this.accentColor);
    for (const msg of messages) {
      const sent = await this.channel.send({ ...msg, allowedMentions: { parse: [] } });
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  isCancelled(): boolean {
    return false;
  }
}
