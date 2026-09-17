import type { FsHost } from "../../contracts.ts";
import "../hosts.ts";
import { grepInRoot, listInRoot, readInRoot } from "./scopedFs.ts";

/** Builds an FsHost over a root directory. `urlFor` optionally maps a repo-relative path to a
 *  tappable citation link (the wiki root supplies git permalinks; a plain root supplies none). */
export function createFsHost(root: string, opts: { label: string; urlFor?: (path: string) => Promise<string | undefined> }): FsHost {
  const urlFor = opts.urlFor ?? (async () => undefined);
  return {
    label: opts.label,
    list: (dir) => listInRoot(root, dir),
    async grep(pattern, limit) {
      const matches = await grepInRoot(root, pattern, limit);
      return Promise.all(matches.map(async (m) => ({ ...m, url: await urlFor(m.path) })));
    },
    async read(path) {
      const content = await readInRoot(root, path);
      if (content === null) return null;
      return { content, url: await urlFor(path) };
    },
  };
}
