import type { ModuleId } from "./modules/registry.ts";

export interface GuildConfig {
  allowedRoles: string[];
  /** Discord emoji strings, e.g. ["<:blobheart:123>", "<a:wave:456>"] */
  emojis?: string[];
  /** Role ID whose ping auto-triggers an investigation. Enables the auto-mod flow. */
  modRoleId?: string;
  /** Channel ID where the bot posts the alert anchor and opens the investigation thread. */
  alertsChannelId?: string;
  /** Role IDs the agent will never action (union with allowedRoles at runtime). */
  modImmuneRoleIds?: string[];
  /** How many days after joining a member is considered "new" for auto-action. Defaults to 3. */
  newMemberThresholdDays?: number;
  /** When true, timeout_member and delete_user_messages no-op instead of hitting the Discord API. send_alert_message still sends, tagged as a dry run. */
  autoModDryRun?: boolean;
  /** Role IDs allowed to trigger the auto-mod flow by pinging modRoleId. If unset, anyone can trigger it. */
  autoModTriggerRoleIds?: string[];
  /** Minimum seconds between auto-mod triggers in the same channel. Defaults to 60. */
  autoModCooldownSeconds?: number;
  /** Discord user ids allowed to reach this guild through the MCP bridge. Unset/empty = unreachable. */
  mcpBridgeAllowedUserIds?: string[];
  /** Which agent modules are active for this guild. Unset defaults to ["moderation"] — see resolvedModules(). */
  enabledModules?: ModuleId[];
}

/** Modules active for this guild — defaults to moderation-only, so configs written before this field existed keep exactly today's behavior. */
export function resolvedModules(cfg: GuildConfig): ModuleId[] {
  return cfg.enabledModules ?? ["moderation"];
}

/** Every guild id whose mcpBridgeAllowedUserIds includes the given Discord user id. */
export function getPermittedGuildIds(
  guildConfig: Record<string, GuildConfig>,
  discordUserId: string,
): string[] {
  return Object.entries(guildConfig)
    .filter(([, cfg]) => cfg.mcpBridgeAllowedUserIds?.includes(discordUserId))
    .map(([guildId]) => guildId);
}

/** Build a name → Discord syntax map from an emojis array. */
export function buildEmojiMap(emojis: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const emoji of emojis) {
    const match = emoji.match(/^<a?:(\w+):\d+>$/);
    if (match) map[match[1]] = emoji;
  }
  return map;
}
