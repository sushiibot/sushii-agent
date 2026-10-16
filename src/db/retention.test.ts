import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { applySchema } from "./index.ts";
import { CONTENT_RETENTION_MS, CLEANUP_RETENTION_MS, DAY_MS, purgeRetainedContent } from "./retention.ts";
import { SqliteConversationStore } from "../core/stores/conversationStore.ts";
import { DiscordMessageCacheHost } from "../surfaces/discord/hosts/messageCacheHost.ts";
import { getUnprocessedMessages } from "./wikiSync.ts";
import { getVerdict } from "../modules/screening/store.ts";

const NOW = 1_800_000_000_000;
let db: Database;
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(NOW);
  db = new Database(":memory:");
  applySchema(db);
});
afterEach(() => { clock.mockRestore(); db.close(); });

function message(id: string, at: number, replyTo: string | null = null): void {
  db.run(`INSERT INTO messages (discord_id, guild_id, channel_id, author_id, content, created_at, reply_to_id)
    VALUES (?, 'guild', 'channel', 'user', ?, ?, ?)`, [id, `needle ${id}`, at, replyTo]);
}

describe("content retention", () => {
  test("cache search and reply joins cannot expose expired content between scheduled sweeps", () => {
    message("expired", NOW - CONTENT_RETENTION_MS);
    message("current", NOW - DAY_MS, "expired");
    const host = new DiscordMessageCacheHost(db, "guild");
    const hits = host.searchMessages({ query: "needle" });
    expect(hits).toEqual([expect.objectContaining({ discordId: "current", replyToContent: null })]);
    expect(db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'expired'").all()).toEqual([]);
    expect(host.getConversationContext({ messageId: "expired" })).toHaveProperty("error");
  });

  test("wiki reads enforce expiry, including reply context", () => {
    message("expired", NOW - CONTENT_RETENTION_MS);
    message("current", NOW - DAY_MS, "expired");
    const hits = getUnprocessedMessages(db, "guild", 0, NOW, 100);
    expect(hits.map((r) => r.messageId)).toEqual(["current"]);
    expect(hits[0]!.replyTo).toBeNull();
  });

  test("active transcripts expire by creation time and an in-flight save cannot resurrect them", () => {
    const store = new SqliteConversationStore(db);
    const ref = { surface: "discord", spaceId: "guild", conversationId: "thread" };
    const data = { messages: [{ role: "user" as const, content: "old secret" }], initialThreadContext: "old context" };
    store.save(ref, data);
    const inFlight = store.load(ref);
    clock.mockReturnValue(NOW + CONTENT_RETENTION_MS - 1);
    store.save(ref, inFlight); // Activity does not extend the original lifetime.
    clock.mockReturnValue(NOW + CONTENT_RETENTION_MS);
    purgeRetainedContent(db);
    store.save(ref, inFlight);
    expect(db.query("SELECT * FROM conversations").all()).toEqual([]);
    expect(store.load(ref)).toEqual({ messages: [], initialThreadContext: null });
    store.save(ref, { messages: [{ role: "user", content: "fresh" }], initialThreadContext: null });
    expect(store.load(ref).messages).toEqual([{ role: "user", content: "fresh" }]);
  });

  test("startup/hourly cleanup deletes early and removes screening snapshots and pending questions", () => {
    message("early", NOW - CLEANUP_RETENTION_MS);
    message("fresh", NOW - DAY_MS);
    db.run(`INSERT INTO screening_verdicts (guild_id, channel_id, user_id, message_id, kind, judged, created_at)
      VALUES ('guild', 'channel', 'user', 'early', 'text', 'old snapshot', ?)`, [NOW - CLEANUP_RETENTION_MS]);
    db.run(`INSERT INTO pending_questions VALUES ('thread', 'old question', '[]', 'user', ?)`, [NOW - DAY_MS]);
    purgeRetainedContent(db);
    expect(db.query("SELECT discord_id FROM messages").all()).toEqual([{ discord_id: "fresh" }]);
    expect(db.query("SELECT * FROM screening_verdicts").all()).toEqual([]);
    expect(db.query("SELECT * FROM pending_questions").all()).toEqual([]);
  });

  test("screening reads refuse expired evidence before the next sweep", () => {
    db.run(`INSERT INTO screening_verdicts (guild_id, channel_id, user_id, message_id, kind, judged, created_at)
      VALUES ('guild', 'channel', 'user', 'old', 'text', 'snapshot', ?)`, [NOW - CONTENT_RETENTION_MS]);
    expect(getVerdict(db, 1)).toBeUndefined();
  });
});
