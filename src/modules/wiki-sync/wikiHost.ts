import { existsSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { FsHost } from "../../core/contracts.ts";
import { createFsHost } from "../../core/tools/fs/host.ts";
import { buildFilePermalink, deriveWebUrl } from "./notify.ts";

const logger = getLogger("wiki-sync:host");

/** Wires a guild's local wiki clone (the checkout wiki-sync keeps updated) as an `fs` root for the
 *  generic read/search/list tools. Reads reflect the last sweep — no per-search network pull.
 *  Citations are commit-pinned git permalinks (like the recap), resolved once per host instance. */
export function createWikiFsHost(guildId: string): FsHost {
  const dir = join(config.wikiSync.cloneDir, guildId);
  const webUrl = config.wikiSync.repoUrl ? deriveWebUrl(config.wikiSync.repoUrl) : null;

  let refPromise: Promise<string | null> | undefined;
  const headSha = (): Promise<string | null> => {
    refPromise ??= (async () => {
      if (!existsSync(join(dir, ".git"))) return null;
      try {
        return (await simpleGit(dir).revparse(["HEAD"])).trim();
      } catch (err) {
        logger.warn({ err, guildId }, "could not resolve wiki HEAD for citation links");
        return null;
      }
    })();
    return refPromise;
  };

  return createFsHost(dir, {
    label: "this server's wiki",
    urlFor: async (path) => {
      if (!webUrl) return undefined;
      const ref = await headSha();
      return ref ? buildFilePermalink(webUrl, ref, path) : undefined;
    },
  });
}
