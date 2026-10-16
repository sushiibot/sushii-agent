import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_RETENTION_MS } from "../../db/retention.ts";

/** Only raw scratch directories, never the curated wiki checkout or its Git history. */
export function purgeWikiScratch(inboxDir: string, sessionsDir: string, now = Date.now()): void {
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).mtimeMs <= now - CLEANUP_RETENTION_MS) unlinkSync(path);
      // Do not follow symlinks out of the scratch directory.
    }
  }
  walk(inboxDir);
  walk(sessionsDir);
}
