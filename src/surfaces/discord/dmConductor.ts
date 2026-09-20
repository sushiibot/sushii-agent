// Owner-only DM conductor: the SurfaceSession + gate for letting the owner drive runner tasks
// from a Discord DM. `DM_SPACE_ID` MUST match authz.ts's PERSONAL_SPACE_CAPABILITIES key exactly
// (spaceKey("discord", DM_SPACE_ID) === "discord:dm") — that map is the pinned contract, not this file.
import type { MessageCreateOptions } from "discord.js";
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
  // No presentInteraction here — a paused turn (ask_question/approval) would deadlock. None of the
  // owner-DM tools (runner tools) pause, so this stays off rather than half-implementing resume UX.
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

  constructor(
    private readonly channel: SendableChannel,
    self: { id: string; username: string },
  ) {
    this.selfId = self.id;
    this.selfName = self.username;
  }

  promptContext(): TurnPromptContext {
    return {};
  }

  async deliver(reply: AgentReply): Promise<{ messageId?: string }> {
    const text = reply.segments
      .map((s) => (s.kind === "separator" ? "\n---\n" : this.renderer.renderText(s.text, { spaceId: DM_SPACE_ID })))
      .join("");
    const footer = renderFooter(reply.usage, reply.toolTrace);
    const full = footer ? (text ? `${text}\n${footer}` : footer) : text;
    if (!full) return {};

    let lastId: string | undefined;
    for (const msg of buildComponentMessages(full)) {
      const sent = await this.channel.send({ ...msg, allowedMentions: { parse: [] } });
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  isCancelled(): boolean {
    return false;
  }
}
