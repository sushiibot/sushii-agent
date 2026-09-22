import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiSyncContext } from "./context.ts";
import { getWikiSources, type WikiSource } from "./sources.ts";
import { runWikiSyncSweep } from "./sweep.ts";

const logger = getLogger("wiki-sync:scheduler");

/** Builds the port bag for one source of a wiki, or null when that surface has no context yet. */
export type MakeWikiSourceContext = (wikiId: string, source: WikiSource) => WikiSyncContext | null;

/** Starts the cron-driven sweep for every configured wiki. `makeContext` yields the capability bag
 *  for one source of a wiki — a surface (Discord) supplies it, so the scheduler itself has no
 *  surface dependency (C14). */
export function startWikiSyncScheduler(makeContext: MakeWikiSourceContext): void {
  const wikiIds = [...getWikiSources().keys()];
  if (wikiIds.length === 0) return;

  logger.info({ wikiIds, cronSchedule: config.wikiSync.cronSchedule }, "starting scheduler");

  Bun.cron(config.wikiSync.cronSchedule, () => {
    for (const wikiId of wikiIds) {
      logger.info({ wikiId }, "scheduled sweep starting");
      runWikiSyncSweep(wikiId, (source) => makeContext(wikiId, source)).catch((err) => {
        logger.error({ wikiId, err }, "scheduled sweep failed");
      });
    }
  });
}
