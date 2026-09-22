import { config } from "../../config.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";

/** One feed into a wiki: a `(surface, spaceId)` pair with an optional status channel for that
 *  surface. Many sources can share one `wikiId`. */
export interface WikiSource {
  surface: string;
  spaceId: string;
  statusChannelId?: string;
}

/**
 * The `wikiId → sources` map. Explicit `WIKI_SYNC_SOURCES` entries win; any enabled Discord guild
 * not already claimed as a `(discord, spaceId)` source by an explicit entry is synthesized as its
 * own single-source wiki (`wikiId === guildId`), which keeps every on-disk repo/inbox path and the
 * per-source watermark identical to the pre-multi-source behavior.
 */
export function getWikiSources(): Map<string, WikiSource[]> {
  const map = new Map<string, WikiSource[]>();
  const claimedDiscordSpaces = new Set<string>();

  for (const [wikiId, entry] of Object.entries(config.wikiSync.sources)) {
    const sources = entry.sources.map((s) => ({ surface: s.surface, spaceId: s.spaceId, statusChannelId: s.statusChannelId }));
    map.set(wikiId, sources);
    for (const s of sources) {
      if (s.surface === "discord") claimedDiscordSpaces.add(s.spaceId);
    }
  }

  for (const guildId of getWikiSyncEnabledGuildIds()) {
    // An explicit entry already sweeps this guild — synthesizing a second wiki for it would double
    // ingest the same messages.
    if (claimedDiscordSpaces.has(guildId)) continue;
    if (map.has(guildId)) continue;
    map.set(guildId, [{ surface: "discord", spaceId: guildId, statusChannelId: config.guildConfig[guildId]?.wiki?.statusChannelId }]);
  }

  return map;
}

/** The wiki a Discord guild's `/wiki-sync` invocation targets: the wiki whose sources include
 *  `(discord, guildId)`, defaulting to the guild id itself (its synthesized single-source wiki). */
export function resolveWikiIdForGuild(guildId: string): string {
  for (const [wikiId, sources] of getWikiSources()) {
    if (sources.some((s) => s.surface === "discord" && s.spaceId === guildId)) return wikiId;
  }
  return guildId;
}
