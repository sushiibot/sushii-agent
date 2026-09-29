import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "./index.ts";
import { WorkspaceLinkStore } from "./workspaceLink.ts";

function store(): WorkspaceLinkStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new WorkspaceLinkStore(db);
}

describe("WorkspaceLinkStore", () => {
  test("prunes seen outbox ids older than the ttl", () => {
    const s = store();
    s.markOutboxSeen("old", "drk", 1_000);
    s.markOutboxSeen("new", "drk", 50_000);
    s.markOutboxSeen("new", "drk", 60_000);
    s.pruneOutboxSeen(10_000, 55_000);
    expect(s.hasSeenOutbox("old")).toBe(false);
    expect(s.hasSeenOutbox("new")).toBe(true);
  });

  test("inbox is per principal and oldest first", () => {
    const s = store();
    s.addInbox("drk", "a", "b");
    s.addInbox("other", "x", "y");
    s.addInbox("drk", "c", "d");
    expect(s.listInbox("drk").map((r) => r.userText)).toEqual(["a", "c"]);
  });

  test("kv upserts", () => {
    const s = store();
    expect(s.getKv("k")).toBeNull();
    s.setKv("k", "1");
    s.setKv("k", "2");
    expect(s.getKv("k")).toBe("2");
  });
});
