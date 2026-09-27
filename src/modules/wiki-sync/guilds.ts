import { config } from "../../config.ts";
import { resolvedModules } from "../../guildConfig.ts";
import type { GuildConfig } from "../../guildConfig.ts";

// Reference-identity cache: rebuilt only when `config.guildConfig` is REASSIGNED (same pattern
// as communities.ts's `index()`), so this stays O(1) per call on the hot per-message path
// instead of re-scanning every guild's resolvedModules() on each wikiFor() call.
let cache: { source: Record<string, GuildConfig>; ids: Set<string> } | null = null;

/** Every guild id that has wiki-sync in its enabledModules. */
export function getWikiSyncEnabledGuildIds(): Set<string> {
  if (!cache || cache.source !== config.guildConfig) {
    const ids = new Set(
      Object.entries(config.guildConfig)
        .filter(([, cfg]) => resolvedModules(cfg).includes("wiki-sync"))
        .map(([guildId]) => guildId),
    );
    cache = { source: config.guildConfig, ids };
  }
  return cache.ids;
}
