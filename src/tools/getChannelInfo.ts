import type { Client } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";

export interface ChannelDetail {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  topic?: string;
  categoryId?: string;
  categoryName?: string;
  parentChannelId?: string;
  parentChannelName?: string;
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

export async function getChannelInfo({
  channel_id,
  guildId,
  client,
}: {
  channel_id: string;
  guildId: string;
  client: Client<true>;
}): Promise<ChannelDetail | { error: string }> {
  const channel = await client.channels.fetch(channel_id);
  if (!channel || !("guild" in channel)) {
    return { error: `Channel ${channel_id} not found or not a guild channel` };
  }

  const guild = await client.guilds.fetch(guildId);
  const everyoneRoleId = guild.roles.everyone.id;

  let isPrivate = false;
  if (channel.type === ChannelType.PrivateThread) {
    isPrivate = true;
  } else if ("permissionOverwrites" in channel) {
    const overwrite = (channel.permissionOverwrites as { cache: Map<string, { deny: { has: (flag: bigint) => boolean } }> }).cache.get(everyoneRoleId);
    isPrivate = overwrite?.deny?.has(PermissionFlagsBits.ViewChannel) ?? false;
  }

  const detail: ChannelDetail = {
    id: channel.id,
    name: "name" in channel ? (channel.name as string) : "(unknown)",
    type: channelTypeName(channel.type),
    isPrivate,
  };

  if ("topic" in channel && channel.topic) detail.topic = channel.topic as string;

  const parentId = "parentId" in channel ? (channel.parentId as string | null) : null;
  if (parentId) {
    const parent = guild.channels.cache.get(parentId) ?? await client.channels.fetch(parentId);
    if (parent && "name" in parent) {
      if (parent.type === ChannelType.GuildCategory) {
        detail.categoryId = parentId;
        detail.categoryName = parent.name as string;
      } else {
        // Thread parent is a text/forum channel, not a category
        detail.parentChannelId = parentId;
        detail.parentChannelName = parent.name as string;

        // Also get the category of the parent channel
        const grandparentId = "parentId" in parent ? (parent.parentId as string | null) : null;
        if (grandparentId) {
          const grandparent = guild.channels.cache.get(grandparentId);
          if (grandparent && grandparent.type === ChannelType.GuildCategory) {
            detail.categoryId = grandparentId;
            detail.categoryName = grandparent.name;
          }
        }
      }
    }
  }

  return detail;
}
