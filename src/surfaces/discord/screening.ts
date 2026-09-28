import {
  AuditLogEvent,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type ContainerBuilder,
  type Guild,
  type GuildAuditLogsEntry,
  type Message,
} from "discord.js";
import { config } from "../../config.ts";
import { getDb } from "../../db/index.ts";
import { getLogger } from "../../logger.ts";
import {
  ignorePost,
  recordMessagesDeleted,
  recordModAction,
  screenMessage,
  screeningEnabled,
  type ScreenedMessage,
  type ScreeningDeps,
} from "../../modules/screening/index.ts";

export { SCREENING_IGNORE_PREFIX } from "../../modules/screening/index.ts";

const logger = getLogger("discord/screening");

function toScreened(message: Message<true>): ScreenedMessage {
  const member = message.member;
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    createdTimestamp: message.createdTimestamp,
    content: message.content,
    embeds: message.embeds.map((e) => ({ image: e.image, thumbnail: e.thumbnail })),
    author: { id: message.author.id, bot: message.author.bot, avatar: message.author.avatar },
    member: member
      ? {
          joinedTimestamp: member.joinedTimestamp,
          avatar: member.avatar,
          roleIds: [...member.roles.cache.keys()],
          avatarUrl: member.displayAvatarURL({ extension: "png", size: 256, forceStatic: true }),
        }
      : null,
  };
}

function deps(client: Client): ScreeningDeps {
  return {
    db: getDb(),
    post: async (channelId: string, container: ContainerBuilder) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error(`screening log channel ${channelId} is not sendable`);
      const sent = await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return sent.id;
    },
    edit: async (channelId: string, messageId: string, container: ContainerBuilder) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ components: [container], allowedMentions: { parse: [] } });
    },
  };
}

let loggedMemberShape = false;

/** Fire-and-forget from MessageCreate/MessageUpdate. */
export function screenDiscordMessage(client: Client, message: Message<true>, opts: { skipText?: boolean } = {}): void {
  const cfg = config.guildConfig[message.guildId];
  if (!cfg || !screeningEnabled(cfg)) return;
  if (!loggedMemberShape && message.member) {
    // Discord only documents MESSAGE_CREATE's member as "partial": confirm the fields screening needs arrive.
    loggedMemberShape = true;
    logger.info({ hasJoinedAt: message.member.joinedTimestamp !== null }, "screening member payload");
  }
  void screenMessage(toScreened(message), cfg, deps(client), opts).catch((err) => {
    logger.warn({ err, messageId: message.id }, "screening failed");
  });
}

export async function handleScreeningIgnore(client: Client, interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const cfg = guildId ? config.guildConfig[guildId] : undefined;
  if (!cfg) return;
  const roles = interaction.member?.roles;
  const roleIds = Array.isArray(roles) ? roles : roles ? [...roles.cache.keys()] : [];
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) || roleIds.some((id) => cfg.allowedRoles.includes(id));
  if (!isMod) {
    await interaction.reply({ content: "Only moderators can do that.", flags: MessageFlags.Ephemeral });
    return;
  }
  const d = deps(client);
  const container = ignorePost(interaction.message.id, interaction.user.id, cfg, d);
  if (!container) {
    // Already ignored or actioned; the post already shows that.
    await interaction.deferUpdate();
    return;
  }
  await interaction.update({ components: [container], allowedMentions: { parse: [] } });
}

export function actionFor(entry: GuildAuditLogsEntry): string | null {
  switch (entry.action) {
    case AuditLogEvent.MemberBanAdd:
      return "banned";
    case AuditLogEvent.MemberKick:
      return "kicked";
    case AuditLogEvent.MemberUpdate: {
      const timeout = entry.changes.find((c) => c.key === "communication_disabled_until");
      return timeout?.new ? "timed out" : null;
    }
    default:
      return null;
  }
}

/** Needs the GuildModeration intent and View Audit Log; without them the event never fires. */
export function handleScreeningAuditEntry(client: Client, entry: GuildAuditLogsEntry, guild: Guild): void {
  const cfg = config.guildConfig[guild.id];
  if (!cfg || !screeningEnabled(cfg)) return;
  const action = actionFor(entry);
  if (!action || !entry.targetId) return;
  void recordModAction(guild.id, entry.targetId, action, entry.executorId, cfg, deps(client)).catch((err) => {
    logger.warn({ err, guildId: guild.id }, "screening mod-action update failed");
  });
}

export function handleScreeningDeletes(client: Client, guildId: string, messageIds: string[]): void {
  const cfg = config.guildConfig[guildId];
  if (!cfg || !screeningEnabled(cfg)) return;
  void recordMessagesDeleted(messageIds, cfg, deps(client)).catch((err) => {
    logger.warn({ err, guildId }, "screening delete update failed");
  });
}
