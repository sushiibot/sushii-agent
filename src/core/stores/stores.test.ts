import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { applySchema } from "../../db/index.ts";
import type { ConversationRef } from "../contracts.ts";
import { SqliteConversationStore } from "./conversationStore.ts";
import { DiscordSpaceMemoryStore, MEMORY_LIMIT } from "./memoryStore.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

const ref: ConversationRef = { surface: "discord", spaceId: "guild1", conversationId: "thread1" };

describe("SqliteConversationStore", () => {
  test("round-trips messages and initialThreadContext", () => {
    const store = new SqliteConversationStore(testDb());
    expect(store.load(ref)).toEqual({ messages: [], initialThreadContext: null });

    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    store.save(ref, { messages, initialThreadContext: "some context" });

    expect(store.load(ref)).toEqual({ messages, initialThreadContext: "some context" });
  });

  test("caps history at 200 messages", () => {
    const store = new SqliteConversationStore(testDb());
    const messages: ModelMessage[] = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    store.save(ref, { messages, initialThreadContext: null });

    const loaded = store.load(ref);
    expect(loaded.messages.length).toBe(200);
    expect(loaded.messages[0].content).toBe("msg 50");
  });

  test("trims leading non-user messages left by the cap", () => {
    const store = new SqliteConversationStore(testDb());
    const messages: ModelMessage[] = [
      { role: "assistant", content: "orphaned tool-call artifact" },
      { role: "tool", content: [] } as unknown as ModelMessage,
      { role: "user", content: "real start" },
      { role: "assistant", content: "reply" },
    ];
    store.save(ref, { messages, initialThreadContext: null });

    const loaded = store.load(ref);
    expect(loaded.messages[0]).toEqual({ role: "user", content: "real start" });
    expect(loaded.messages.length).toBe(2);
  });

  test("upsert on save keeps guildId/threadId keyed by ref", () => {
    const store = new SqliteConversationStore(testDb());
    store.save(ref, { messages: [{ role: "user", content: "a" }], initialThreadContext: null });
    store.save(ref, { messages: [{ role: "user", content: "b" }], initialThreadContext: null });

    expect(store.load(ref).messages).toEqual([{ role: "user", content: "b" }]);
  });

  test("deleteStale removes conversations older than maxAgeMs", () => {
    const db = testDb();
    const store = new SqliteConversationStore(db);
    store.save(ref, { messages: [{ role: "user", content: "a" }], initialThreadContext: null });

    store.deleteStale(-1); // negative maxAge => cutoff in the future, everything is "stale"
    expect(store.load(ref)).toEqual({ messages: [], initialThreadContext: null });
  });
});

describe("DiscordSpaceMemoryStore", () => {
  const spaceId = "guild1";

  test("server context round-trips and defaults to null", () => {
    const store = new DiscordSpaceMemoryStore(testDb());
    expect(store.getServerContext(spaceId)).toBeNull();
    store.setServerContext(spaceId, "# context");
    expect(store.getServerContext(spaceId)).toBe("# context");
  });

  test("upsert/read/listTitles/count/delete round-trip", () => {
    const store = new DiscordSpaceMemoryStore(testDb());
    expect(store.upsert(spaceId, "title1", "content1")).toEqual({ ok: true });

    const entry = store.read(spaceId, "title1");
    expect(entry?.title).toBe("title1");
    expect(entry?.content).toBe("content1");

    expect(store.listTitles(spaceId)).toEqual(["title1"]);
    expect(store.count(spaceId)).toBe(1);

    expect(store.upsert(spaceId, "title1", "updated")).toEqual({ ok: true });
    expect(store.read(spaceId, "title1")?.content).toBe("updated");

    expect(store.delete(spaceId, "title1")).toBe(true);
    expect(store.read(spaceId, "title1")).toBeNull();
    expect(store.delete(spaceId, "title1")).toBe(false);
  });

  test("enforces MEMORY_LIMIT on new titles but allows updating existing ones", () => {
    const store = new DiscordSpaceMemoryStore(testDb());
    for (let i = 0; i < MEMORY_LIMIT; i++) {
      expect(store.upsert(spaceId, `title${i}`, "c")).toEqual({ ok: true });
    }
    expect(store.count(spaceId)).toBe(MEMORY_LIMIT);

    const result = store.upsert(spaceId, "one-too-many", "c");
    expect(result).toEqual({ error: expect.stringContaining("Memory limit reached") });

    // Updating an existing title stays under the limit.
    expect(store.upsert(spaceId, "title0", "updated")).toEqual({ ok: true });
  });

  test("search matches via FTS with prefix-wrapped bare terms, scoped to spaceId", () => {
    const store = new DiscordSpaceMemoryStore(testDb());
    store.upsert(spaceId, "deploy runbook", "how to deploy the bot");
    store.upsert(spaceId, "unrelated", "something else entirely");
    store.upsert("other-guild", "deploy runbook", "a different guild's deploy notes");

    const results = store.search(spaceId, "deploy");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("deploy runbook");
  });
});
