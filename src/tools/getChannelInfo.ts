import type { Client } from "discord.js";
import { ChannelType } from "discord.js";
import { channelTypeName, isPrivateChannel } from "./channelUtils.ts";

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

  const isPrivate = isPrivateChannel(channel as Parameters<typeof isPrivateChannel>[0], everyoneRoleId);

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
