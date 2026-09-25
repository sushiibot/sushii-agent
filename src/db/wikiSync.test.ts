import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { applySchema } from "./index.ts";
import * as schema from "./schema.ts";
import { getUnprocessedMessages, getWikiSyncWatermark, setWikiSyncWatermark } from "./wikiSync.ts";

const realMigrationsDir = join(import.meta.dir, "..", "..", "drizzle");

/** Effectively unbounded `until` for tests that don't care about the upper window edge. */
const UNTIL_MAX = Number.MAX_SAFE_INTEGER;

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function insertMessage(
  db: Database,
  opts: {
    discordId: string;
    guildId: string;
    createdAt: number;
    isBot?: boolean;
    deletedAt?: number | null;
    channelId?: string;
    parentChannelId?: string | null;
    replyToId?: string | null;
    authorUsername?: string;
    authorDisplayName?: string | null;
    content?: string;
  },
): void {
  db.run(
    `INSERT INTO messages (discord_id, guild_id, channel_id, parent_channel_id, author_id, content,
       reply_to_id, created_at, author_username, author_display_name, is_bot, deleted_at)
     VALUES (?, ?, ?, ?, 'author', ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.discordId,
      opts.guildId,
      opts.channelId ?? "chan",
      opts.parentChannelId ?? null,
      opts.content ?? "hello",
      opts.replyToId ?? null,
      opts.createdAt,
      opts.authorUsername ?? "author",
      opts.authorDisplayName ?? null,
      opts.isBot ? 1 : 0,
      opts.deletedAt ?? null,
    ],
  );
}

describe("wiki-sync watermark", () => {
  test("defaults to 0 for a source that has never synced", () => {
    const db = testDb();
    expect(getWikiSyncWatermark(db, "w1", "discord", "w1")).toBe(0);
  });

  test("round-trips a set watermark", () => {
    const db = testDb();
    setWikiSyncWatermark(db, "w1", "discord", "w1", 12345);
    expect(getWikiSyncWatermark(db, "w1", "discord", "w1")).toBe(12345);
  });

  test("upserts on repeated sets for the same source", () => {
    const db = testDb();
    setWikiSyncWatermark(db, "w1", "discord", "w1", 100);
    setWikiSyncWatermark(db, "w1", "discord", "w1", 200);
    expect(getWikiSyncWatermark(db, "w1", "discord", "w1")).toBe(200);
  });

  test("tracks watermarks independently per source of the same wiki", () => {
    const db = testDb();
    setWikiSyncWatermark(db, "w1", "discord", "g1", 100);
    setWikiSyncWatermark(db, "w1", "slack", "T1", 200);
    expect(getWikiSyncWatermark(db, "w1", "discord", "g1")).toBe(100);
    expect(getWikiSyncWatermark(db, "w1", "slack", "T1")).toBe(200);
  });
});

// The 0007 migration backfills the old single-source table into the per-source one. A dropped or
// zeroed watermark re-ingests ~30 days and reproduces a known "repeated content" bug, so this
// asserts the preserved VALUE through the exact prod upgrade path: a DB migrated to 0006 by
// drizzle's own journal, then 0007 applied on top — not a hand-run INSERT.
describe("wiki_sync_state → wiki_sync_source_state migration", () => {
  test("preserves an existing discord watermark value through the real 0006 → 0007 upgrade", () => {
    // Build a migrations folder frozen at the pre-0007 state (drop the journal entries for 0007
    // and later) so drizzle writes its own 0000–0006 journal, exactly as prod's DB had it.
    const scratch = mkdtempSync(join(tmpdir(), "wiki-sync-pre0007-"));
    cpSync(realMigrationsDir, scratch, { recursive: true });
    const journalPath = join(scratch, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx < 7);
    writeFileSync(journalPath, JSON.stringify(journal));

    const db = new Database(":memory:");
    try {
      const orm = drizzle({ client: db, schema });
      migrate(orm, { migrationsFolder: scratch }); // 0000–0006, drizzle-written journal
      db.run("INSERT INTO wiki_sync_state (guild_id, last_processed_at) VALUES ('G1', 12345)");

      applySchema(db); // applies 0007 onward

      expect(getWikiSyncWatermark(db, "G1", "discord", "G1")).toBe(12345);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'wiki_sync_state'").all()).toHaveLength(0);
    } finally {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("getUnprocessedMessages", () => {
  test("returns only messages newer than the watermark, oldest first", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 300 });
    insertMessage(db, { discordId: "3", guildId: "g1", createdAt: 200 });

    const result = getUnprocessedMessages(db, "g1", 150, UNTIL_MAX, 100);
    expect(result.map((m) => m.messageId)).toEqual(["3", "2"]);
  });

  test("stamps each row with surface 'discord' and the queried spaceId", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result[0]!.surface).toBe("discord");
    expect(result[0]!.spaceId).toBe("g1");
  });

  test("excludes bot messages", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, isBot: true });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200 });

    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result.map((m) => m.messageId)).toEqual(["2"]);
  });

  test("excludes soft-deleted messages", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, deletedAt: 150 });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200 });

    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result.map((m) => m.messageId)).toEqual(["2"]);
  });

  test("excludes other guilds", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    insertMessage(db, { discordId: "2", guildId: "g2", createdAt: 100 });

    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result.map((m) => m.messageId)).toEqual(["1"]);
  });

  test("respects the limit", () => {
    const db = testDb();
    for (let i = 0; i < 5; i++) {
      insertMessage(db, { discordId: String(i), guildId: "g1", createdAt: i });
    }
    const result = getUnprocessedMessages(db, "g1", -1, UNTIL_MAX, 2);
    expect(result.length).toBe(2);
  });

  test("excludes messages newer than until", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200 });
    insertMessage(db, { discordId: "3", guildId: "g1", createdAt: 300 });

    const result = getUnprocessedMessages(db, "g1", 0, 200, 100);
    expect(result.map((m) => m.messageId)).toEqual(["1", "2"]);
  });

  test("carries parentChannelId through for thread messages", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, channelId: "thread-1", parentChannelId: "general" });
    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result[0]!.parentChannelId).toBe("general");
  });

  test("parentChannelId is null for an ordinary (non-thread) message", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result[0]!.parentChannelId).toBeNull();
  });

  test("resolves replyTo from the target message, preferring display name", () => {
    const db = testDb();
    insertMessage(db, {
      discordId: "1",
      guildId: "g1",
      createdAt: 100,
      authorUsername: "pham_real",
      authorDisplayName: "pham",
      content: "is this still broken?",
    });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200, replyToId: "1", content: "yes, still broken" });

    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    const reply = result.find((m) => m.messageId === "2")!;
    expect(reply.replyTo).toEqual({ author: "pham", content: "is this still broken?" });
  });

  test("replyTo is null when the message doesn't reply to anything", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    expect(result[0]!.replyTo).toBeNull();
  });

  test("truncates a long reply target to a snippet", () => {
    const db = testDb();
    const longContent = "x".repeat(200);
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, content: longContent });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200, replyToId: "1" });

    const result = getUnprocessedMessages(db, "g1", 0, UNTIL_MAX, 100);
    const reply = result.find((m) => m.messageId === "2")!;
    expect(reply.replyTo!.content.length).toBe(121); // 120 chars + ellipsis
    expect(reply.replyTo!.content.endsWith("…")).toBe(true);
  });
});
