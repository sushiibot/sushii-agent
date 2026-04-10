import type { Client } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  topic?: string;
  categoryId?: string;
  categoryName?: string;
}

function channelTypeName(type: ChannelType): string {
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

function isPrivateChannel(channel: { type: ChannelType; permissionOverwrites?: { cache: Map<string, { deny: { has: (flag: bigint) => boolean } }> } }, everyoneRoleId: string): boolean {
  if (channel.type === ChannelType.PrivateThread) return true;
  const overwrite = channel.permissionOverwrites?.cache?.get(everyoneRoleId);
  return overwrite?.deny?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

export async function listGuildChannels({
  guildId,
  client,
}: {
  guildId: string;
  client: Client<true>;
}): Promise<ChannelInfo[]> {
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch(); // Populate cache
  const everyoneRoleId = guild.roles.everyone.id;

  // Group non-category channels by their parent category ID (or null)
  const byCategory = new Map<string | null, ChannelInfo[]>();

  for (const [, channel] of guild.channels.cache) {
    if (!channel) continue;
    if (channel.type === ChannelType.GuildCategory) continue;
    // Skip voice/stage unless relevant
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) continue;

    const parentId = "parentId" in channel ? channel.parentId : null;
    if (!byCategory.has(parentId)) byCategory.set(parentId, []);

    const info: ChannelInfo = {
      id: channel.id,
      name: channel.name,
      type: channelTypeName(channel.type),
      isPrivate: isPrivateChannel(channel as Parameters<typeof isPrivateChannel>[0], everyoneRoleId),
    };

    if ("topic" in channel && channel.topic) info.topic = channel.topic;

    byCategory.get(parentId)!.push(info);
  }

  const result: ChannelInfo[] = [];

  // Channels under categories (in category position order)
  const categories = [...guild.channels.cache.values()]
    .filter((c) => c?.type === ChannelType.GuildCategory)
    .sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));

  for (const cat of categories) {
    if (!cat) continue;
    const children = (byCategory.get(cat.id) ?? []).sort((a, b) => {
      const ca = guild.channels.cache.get(a.id);
      const cb = guild.channels.cache.get(b.id);
      return ((ca as { position?: number })?.position ?? 0) - ((cb as { position?: number })?.position ?? 0);
    });
    for (const ch of children) {
      ch.categoryId = cat.id;
      ch.categoryName = cat.name;
      result.push(ch);
    }
  }

  // Uncategorized channels
  for (const ch of byCategory.get(null) ?? []) {
    result.push(ch);
  }

  return result;
}
