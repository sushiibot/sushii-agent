import { config } from "./config.ts";

/** Agent modules a guild can enable. Wiki participation is not a module — it's driven by a
 *  team's `wiki.wikiId` plus the space's `wiki: "source"|"read"` role (see orchestration/teams.ts). */
export type ModuleId = "moderation" | "mcp" | "ops-triage";

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
  /** Persona for the bot in this guild: "moderation" (investigate + recommend for mods) or "general"
   *  (a community assistant). Unset = moderation, matching configs written before this field existed. */
  promptTemplate?: "moderation" | "general";
  /** Which agent modules are active for this guild. Unset defaults to ["moderation"] — see resolvedModules(). */
  enabledModules?: ModuleId[];
  /** wiki-sync module settings for this guild. */
  wiki?: {
    /** Channel ID where wiki-sync posts a status update after each sweep that pushes a commit. Unset = no notification. */
    statusChannelId?: string;
  };
}

/** Modules active for this guild — defaults to moderation-only, so configs written before this field existed keep exactly today's behavior. */
export function resolvedModules(cfg: GuildConfig): ModuleId[] {
  return cfg.enabledModules ?? ["moderation"];
}

/** Whether the moderation module is active for this space — true only on Discord, and only when the
 *  guild is configured and has "moderation" among its resolved modules. */
export function moderationEnabled(surface: string, spaceId: string): boolean {
  if (surface !== "discord") return false;
  const cfg = config.guildConfig[spaceId];
  if (!cfg) return false;
  return resolvedModules(cfg).includes("moderation");
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
