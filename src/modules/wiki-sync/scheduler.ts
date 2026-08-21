import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";
import { runWikiSyncSweep } from "./sweep.ts";

const logger = getLogger("wiki-sync:scheduler");

/** Starts the cron-equivalent sweep loop for every guild with wiki-sync enabled. */
export function startWikiSyncScheduler(): void {
  const guildIds = getWikiSyncEnabledGuildIds();
  if (guildIds.length === 0) return;

  const intervalMs = config.wikiSyncIntervalMinutes * 60 * 1000;
  logger.info({ guildIds, intervalMinutes: config.wikiSyncIntervalMinutes }, "starting wiki-sync scheduler");

  setInterval(() => {
    for (const guildId of guildIds) {
      runWikiSyncSweep(guildId).catch((err) => {
        logger.error({ guildId, err }, "scheduled wiki-sync sweep failed");
      });
    }
  }, intervalMs);
}
