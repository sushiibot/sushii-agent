import type { Message } from "discord.js";
import type { GuildConfig } from "../../guildConfig.ts";

// Auto-mod trigger eligibility + cooldown. Ported from the pre-cutover moderation/dispatch.ts; the
// cooldown map is surface-local now that only the Discord gateway reads it (behavior-neutral).

const DEFAULT_AUTOMOD_COOLDOWN_SECONDS = 60;
const autoModCooldowns = new Map<string, number>();

/** Mod role pinged by an authorized role — does not require a bot mention. */
export function isAutoModEligible(message: Message, guildConfig: GuildConfig): boolean {
  return Boolean(
    guildConfig.modRoleId &&
      guildConfig.alertsChannelId &&
      message.mentions.roles.has(guildConfig.modRoleId) &&
      (!guildConfig.autoModTriggerRoleIds?.length ||
        (message.member?.roles.cache.hasAny(...guildConfig.autoModTriggerRoleIds) ?? false)),
  );
}

/** Collapses repeated pings for the same incident into a single investigation. Returns true and
 *  records the trigger time if the cooldown elapsed, false if suppressed. */
export function checkAndSetAutoModCooldown(guildId: string, channelId: string, guildConfig: GuildConfig): boolean {
  const cooldownKey = `${guildId}:${channelId}`;
  const cooldownMs = (guildConfig.autoModCooldownSeconds ?? DEFAULT_AUTOMOD_COOLDOWN_SECONDS) * 1000;
  const lastTriggered = autoModCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastTriggered < cooldownMs) return false;
  autoModCooldowns.set(cooldownKey, Date.now());
  return true;
}
