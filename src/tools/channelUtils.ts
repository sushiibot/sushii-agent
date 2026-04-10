import { ChannelType, PermissionFlagsBits } from "discord.js";

export function channelTypeName(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText: return "text";
    case ChannelType.GuildVoice: return "voice";
    case ChannelType.GuildAnnouncement: return "announcement";
    case ChannelType.GuildForum: return "forum";
    case ChannelType.GuildStageVoice: return "stage";
    case ChannelType.PublicThread: return "thread (public)";
    case ChannelType.PrivateThread: return "thread (private)";
    default: return "other";
  }
}

export function isPrivateChannel(
  channel: { type: ChannelType; permissionOverwrites?: { cache: Map<string, { deny: { has: (flag: bigint) => boolean } }> } },
  everyoneRoleId: string,
): boolean {
  if (channel.type === ChannelType.PrivateThread) return true;
  const overwrite = channel.permissionOverwrites?.cache?.get(everyoneRoleId);
  return overwrite?.deny?.has(PermissionFlagsBits.ViewChannel) ?? false;
}
