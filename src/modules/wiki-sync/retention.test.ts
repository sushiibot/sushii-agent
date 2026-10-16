import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEANUP_RETENTION_MS } from "../../db/retention.ts";
import { purgeWikiScratch } from "./retention.ts";

test("ages out raw inboxes and old sessions while preserving fresh work and curated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-retention-"));
  try {
    const inbox = join(dir, "inbox");
    const sessions = join(dir, "sessions");
    const wiki = join(dir, "repo");
    for (const folder of [inbox, sessions, wiki]) mkdirSync(folder);
    const now = Date.now();
    const old = new Date(now - CLEANUP_RETENTION_MS - 1000);
    for (const file of [join(inbox, "old.md"), join(sessions, "old.jsonl"), join(wiki, "curated.md")]) {
      writeFileSync(file, "content");
      utimesSync(file, old, old);
    }
    writeFileSync(join(inbox, "fresh.md"), "working");
    symlinkSync(wiki, join(inbox, "wiki-link"));
    purgeWikiScratch(inbox, sessions, now);
    expect(existsSync(join(inbox, "old.md"))).toBe(false);
    expect(existsSync(join(sessions, "old.jsonl"))).toBe(false);
    expect(existsSync(join(inbox, "fresh.md"))).toBe(true);
    expect(existsSync(join(wiki, "curated.md"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
