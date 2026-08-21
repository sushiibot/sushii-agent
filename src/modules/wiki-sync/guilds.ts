import { config } from "../../config.ts";
import { resolvedModules } from "../../guildConfig.ts";

/** Every guild id that has wiki-sync in its enabledModules. */
export function getWikiSyncEnabledGuildIds(): string[] {
  return Object.entries(config.guildConfig)
    .filter(([, cfg]) => resolvedModules(cfg).includes("wiki-sync"))
    .map(([guildId]) => guildId);
}
