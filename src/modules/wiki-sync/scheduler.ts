import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";
import type { WikiSyncContext } from "./context.ts";
import { runWikiSyncSweep } from "./sweep.ts";

const logger = getLogger("wiki-sync:scheduler");

/** Starts the cron-driven sweep for every guild with wiki-sync enabled. `makeContext` yields the
 *  capability bag for a guild — a surface (Discord) or a headless driver supplies it, so the
 *  scheduler itself has no surface dependency (C14). */
export function startWikiSyncScheduler(makeContext: (guildId: string) => WikiSyncContext): void {
  const guildIds = getWikiSyncEnabledGuildIds();
  if (guildIds.length === 0) return;

  logger.info({ guildIds, cronSchedule: config.wikiSync.cronSchedule }, "starting scheduler");

  Bun.cron(config.wikiSync.cronSchedule, () => {
    for (const guildId of guildIds) {
      logger.info({ guildId }, "scheduled sweep starting");
      runWikiSyncSweep(guildId, makeContext(guildId)).catch((err) => {
        logger.error({ guildId, err }, "scheduled sweep failed");
      });
    }
  });
}
