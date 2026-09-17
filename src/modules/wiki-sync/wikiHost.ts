import { existsSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiHost } from "../../core/contracts.ts";
import "../../core/tools/hosts.ts";
import { buildFilePermalink, deriveWebUrl } from "./notify.ts";
import { readWikiPage, searchWikiPages } from "./search.ts";

const logger = getLogger("wiki-sync:host");

/** A WikiHost over a guild's local wiki clone (the checkout wiki-sync keeps updated). Search reflects
 *  the last sweep — no per-search network pull. Citations are commit-pinned permalinks (like the
 *  post-sweep recap), resolved once per host instance. */
export function createWikiHost(guildId: string): WikiHost {
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

  const urlFor = async (path: string): Promise<string | undefined> => {
    if (!webUrl) return undefined;
    const ref = await headSha();
    return ref ? buildFilePermalink(webUrl, ref, path) : undefined;
  };

  return {
    async search(query, limit) {
      const hits = await searchWikiPages(dir, query, limit);
      return Promise.all(hits.map(async (h) => ({ path: h.path, title: h.title, snippet: h.snippet, url: await urlFor(h.path) })));
    },
    async read(path) {
      const content = await readWikiPage(dir, path);
      if (content === null) return null;
      return { content, url: await urlFor(path) };
    },
  };
}
