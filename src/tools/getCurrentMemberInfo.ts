import type { Client } from "discord.js";

interface GetCurrentMemberInfoArgs {
  user_id: string;
  guildId: string; // injected by runner
  client: Client<true>; // injected by runner
}

export async function getCurrentMemberInfo(args: GetCurrentMemberInfoArgs) {
  const guild =
    args.client.guilds.cache.get(args.guildId) ??
    (await args.client.guilds.fetch(args.guildId));

  try {
    const member = await guild.members.fetch(args.user_id);

    return {
      userId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      joinedAt: member.joinedAt?.getTime() ?? null,
      roles: member.roles.cache
        .filter((r) => r.id !== args.guildId) // exclude @everyone
        .map((r) => ({ id: r.id, name: r.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      isStillInServer: true,
    };
  } catch {
    // DiscordAPIError 10007: Unknown Member — user has left the server
    return {
      userId: args.user_id,
      isStillInServer: false,
    };
  }
}
