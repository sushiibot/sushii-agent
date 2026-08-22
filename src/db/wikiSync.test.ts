import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "./schema.ts";
import { getUnprocessedMessages, getWikiSyncWatermark, setWikiSyncWatermark } from "./wikiSync.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    for (const sql of migration) db.exec(sql);
  }
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
  test("defaults to 0 for a guild that has never synced", () => {
    const db = testDb();
    expect(getWikiSyncWatermark(db, "g1")).toBe(0);
  });

  test("round-trips a set watermark", () => {
    const db = testDb();
    setWikiSyncWatermark(db, "g1", 12345);
    expect(getWikiSyncWatermark(db, "g1")).toBe(12345);
  });

  test("upserts on repeated sets for the same guild", () => {
    const db = testDb();
    setWikiSyncWatermark(db, "g1", 100);
    setWikiSyncWatermark(db, "g1", 200);
    expect(getWikiSyncWatermark(db, "g1")).toBe(200);
  });

  test("tracks watermarks independently per guild", () => {
    const db = testDb();
    setWikiSyncWatermark(db, "g1", 100);
    setWikiSyncWatermark(db, "g2", 200);
    expect(getWikiSyncWatermark(db, "g1")).toBe(100);
    expect(getWikiSyncWatermark(db, "g2")).toBe(200);
  });
});

describe("getUnprocessedMessages", () => {
  test("returns only messages newer than the watermark, oldest first", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 300 });
    insertMessage(db, { discordId: "3", guildId: "g1", createdAt: 200 });

    const result = getUnprocessedMessages(db, "g1", 150, 100);
    expect(result.map((m) => m.discordId)).toEqual(["3", "2"]);
  });

  test("excludes bot messages", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, isBot: true });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200 });

    const result = getUnprocessedMessages(db, "g1", 0, 100);
    expect(result.map((m) => m.discordId)).toEqual(["2"]);
  });

  test("excludes soft-deleted messages", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, deletedAt: 150 });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200 });

    const result = getUnprocessedMessages(db, "g1", 0, 100);
    expect(result.map((m) => m.discordId)).toEqual(["2"]);
  });

  test("excludes other guilds", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    insertMessage(db, { discordId: "2", guildId: "g2", createdAt: 100 });

    const result = getUnprocessedMessages(db, "g1", 0, 100);
    expect(result.map((m) => m.discordId)).toEqual(["1"]);
  });

  test("respects the limit", () => {
    const db = testDb();
    for (let i = 0; i < 5; i++) {
      insertMessage(db, { discordId: String(i), guildId: "g1", createdAt: i });
    }
    const result = getUnprocessedMessages(db, "g1", -1, 2);
    expect(result.length).toBe(2);
  });

  test("carries parentChannelId through for thread messages", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, channelId: "thread-1", parentChannelId: "general" });
    const result = getUnprocessedMessages(db, "g1", 0, 100);
    expect(result[0]!.parentChannelId).toBe("general");
  });

  test("parentChannelId is null for an ordinary (non-thread) message", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    const result = getUnprocessedMessages(db, "g1", 0, 100);
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

    const result = getUnprocessedMessages(db, "g1", 0, 100);
    const reply = result.find((m) => m.discordId === "2")!;
    expect(reply.replyTo).toEqual({ author: "pham", content: "is this still broken?" });
  });

  test("replyTo is null when the message doesn't reply to anything", () => {
    const db = testDb();
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100 });
    const result = getUnprocessedMessages(db, "g1", 0, 100);
    expect(result[0]!.replyTo).toBeNull();
  });

  test("truncates a long reply target to a snippet", () => {
    const db = testDb();
    const longContent = "x".repeat(200);
    insertMessage(db, { discordId: "1", guildId: "g1", createdAt: 100, content: longContent });
    insertMessage(db, { discordId: "2", guildId: "g1", createdAt: 200, replyToId: "1" });

    const result = getUnprocessedMessages(db, "g1", 0, 100);
    const reply = result.find((m) => m.discordId === "2")!;
    expect(reply.replyTo!.content.length).toBe(121); // 120 chars + ellipsis
    expect(reply.replyTo!.content.endsWith("…")).toBe(true);
  });
});
