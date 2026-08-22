import type { Client } from "discord.js";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";
import { runWikiSyncSweep } from "./sweep.ts";

const logger = getLogger("wiki-sync:scheduler");

/** Starts the cron-driven sweep for every guild with wiki-sync enabled. */
export function startWikiSyncScheduler(client: Client): void {
  const guildIds = getWikiSyncEnabledGuildIds();
  if (guildIds.length === 0) return;

  logger.info({ guildIds, cronSchedule: config.wikiSync.cronSchedule }, "starting scheduler");

  Bun.cron(config.wikiSync.cronSchedule, () => {
    for (const guildId of guildIds) {
      logger.info({ guildId }, "scheduled sweep starting");
      runWikiSyncSweep(guildId, client).catch((err) => {
        logger.error({ guildId, err }, "scheduled sweep failed");
      });
    }
  });
}
