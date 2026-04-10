import type { Client } from "discord.js";
import { PermissionFlagsBits } from "discord.js";

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  color?: string;
  isAdmin: boolean;
  isModerator: boolean;
  memberCount: number;
}

export async function listGuildRoles({
  guildId,
  client,
}: {
  guildId: string;
  client: Client<true>;
}): Promise<RoleInfo[]> {
  const guild = await client.guilds.fetch(guildId);
  await guild.roles.fetch();
  await guild.members.fetch();

  return [...guild.roles.cache.values()]
    .filter((r) => r.name !== "@everyone")
    .sort((a, b) => b.position - a.position)
    .map((r) => {
      const perms = r.permissions;
      const info: RoleInfo = {
        id: r.id,
        name: r.name,
        position: r.position,
        isAdmin: perms.has(PermissionFlagsBits.Administrator),
        isModerator:
          perms.has(PermissionFlagsBits.Administrator) ||
          perms.has(PermissionFlagsBits.BanMembers) ||
          perms.has(PermissionFlagsBits.KickMembers) ||
          perms.has(PermissionFlagsBits.ModerateMembers) ||
          perms.has(PermissionFlagsBits.ManageMessages),
        memberCount: r.members.size,
      };
      const hex = r.hexColor;
      if (hex && hex !== "#000000") info.color = hex;
      return info;
    });
}
