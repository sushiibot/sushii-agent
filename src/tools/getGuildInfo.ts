import type { Client } from "discord.js";
import { GuildVerificationLevel } from "discord.js";

export interface GuildInfo {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  memberCount: number;
  verificationLevel: string;
  boostTier: number;
  boostCount: number;
  description?: string;
  preferredLocale: string;
  features: string[];
}

function verificationLevelName(level: GuildVerificationLevel): string {
  switch (level) {
    case GuildVerificationLevel.None: return "none";
    case GuildVerificationLevel.Low: return "low (verified email)";
    case GuildVerificationLevel.Medium: return "medium (registered 5+ min)";
    case GuildVerificationLevel.High: return "high (member 10+ min)";
    case GuildVerificationLevel.VeryHigh: return "very high (verified phone)";
    default: return "unknown";
  }
}

const NOTABLE_FEATURES = new Set([
  "COMMUNITY",
  "DISCOVERABLE",
  "PARTNERED",
  "VERIFIED",
  "NEWS",
  "ANIMATED_ICON",
  "BANNER",
  "INVITE_SPLASH",
  "WELCOME_SCREEN_ENABLED",
  "MEMBER_VERIFICATION_GATE_ENABLED",
  "PREVIEW_ENABLED",
  "TICKETED_EVENTS_ENABLED",
  "MONETIZATION_ENABLED",
  "MORE_STICKERS",
  "THREADS_ENABLED",
  "PRIVATE_THREADS",
  "ROLE_ICONS",
  "AUTO_MODERATION",
]);

export async function getGuildInfo({
  guildId,
  client,
}: {
  guildId: string;
  client: Client<true>;
}): Promise<GuildInfo | { error: string }> {
  try {
    const guild = await client.guilds.fetch({ guild: guildId, withCounts: true });

    const features = guild.features
      .filter((f) => NOTABLE_FEATURES.has(f))
      .map((f) => f.toLowerCase().replace(/_/g, "-"));

    const info: GuildInfo = {
      id: guild.id,
      name: guild.name,
      ownerId: guild.ownerId,
      createdAt: guild.createdTimestamp,
      memberCount: guild.approximateMemberCount ?? guild.memberCount,
      verificationLevel: verificationLevelName(guild.verificationLevel),
      boostTier: guild.premiumTier,
      boostCount: guild.premiumSubscriptionCount ?? 0,
      preferredLocale: guild.preferredLocale,
      features,
    };

    if (guild.description) info.description = guild.description;

    return info;
  } catch (err) {
    return { error: `Failed to fetch guild info: ${err}` };
  }
}
