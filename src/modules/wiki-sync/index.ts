import type { StandaloneModuleDefinition } from "../registry.ts";
import { runWikiSyncSweep } from "./sweep.ts";

export const wikiSyncModule: StandaloneModuleDefinition = {
  kind: "standalone",
  id: "wiki-sync",
  run: async (ctx) => {
    await runWikiSyncSweep(ctx.guildId, ctx.client);
  },
};

export { startWikiSyncScheduler } from "./scheduler.ts";
export { registerWikiSyncCommands, handleWikiSyncCommand, WIKI_SYNC_COMMAND_NAME } from "./command.ts";
export { runWikiSyncSweep } from "./sweep.ts";
