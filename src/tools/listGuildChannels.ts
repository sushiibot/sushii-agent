import type { Client } from "discord.js";
import { ChannelType } from "discord.js";
import { channelTypeName, isPrivateChannel } from "./channelUtils.ts";

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  topic?: string;
  categoryId?: string;
  categoryName?: string;
}

export async function listGuildChannels({
  guildId,
  client,
}: {
  guildId: string;
  client: Client<true>;
}): Promise<ChannelInfo[] | { error: string }> {
  try {
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
  } catch (err) {
    return { error: `Failed to fetch guild channels: ${err}` };
  }
}
