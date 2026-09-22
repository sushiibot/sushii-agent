import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "./index.ts";
import {
  getSlackMessage,
  getSlackSyncState,
  markSlackMessageDeleted,
  setSlackSyncState,
  upsertSlackMessage,
  type SlackMessageRow,
} from "./slackMessages.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function row(overrides: Partial<SlackMessageRow> = {}): SlackMessageRow {
  return {
    channel: "C1",
    ts: "1000.0001",
    text: "hello",
    createdAt: 1000000,
    rawJson: JSON.stringify({ text: "hello" }),
    ingestedAt: 1,
    ...overrides,
  };
}

describe("slackMessages upsert", () => {
  test("idempotent on (channel, ts) — second write wins, one row", () => {
    const db = testDb();
    upsertSlackMessage(db, row({ text: "first" }));
    upsertSlackMessage(db, row({ text: "second" }));
    const stored = getSlackMessage(db, "C1", "1000.0001");
    expect(stored?.text).toBe("second");
    const count = db.query("SELECT COUNT(*) AS n FROM slack_messages").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("different ts in same channel are distinct rows", () => {
    const db = testDb();
    upsertSlackMessage(db, row({ ts: "1000.0001" }));
    upsertSlackMessage(db, row({ ts: "1000.0002" }));
    const count = db.query("SELECT COUNT(*) AS n FROM slack_messages").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("delete tombstones without destroying archived content", () => {
    const db = testDb();
    upsertSlackMessage(db, row({ text: "keep me" }));
    markSlackMessageDeleted(db, {
      ...row({ text: "" }),
      rawJson: JSON.stringify({ subtype: "message_deleted", deleted_ts: "1000.0001" }),
      deletedAt: 42,
    });
    const stored = getSlackMessage(db, "C1", "1000.0001");
    expect(stored?.text).toBe("keep me");
    expect(stored?.deletedAt).toBe(42);
  });

  test("a later backfill upsert does not resurrect a tombstoned message", () => {
    const db = testDb();
    upsertSlackMessage(db, row({ text: "original" }));
    markSlackMessageDeleted(db, { ...row({ text: "" }), rawJson: "{}", deletedAt: 42 });
    // backfill re-encounters the same (channel, ts) and upserts — deletedAt must survive.
    upsertSlackMessage(db, row({ text: "original" }));
    expect(getSlackMessage(db, "C1", "1000.0001")?.deletedAt).toBe(42);
  });

  test("delete of a never-seen message inserts content from previous_message", () => {
    const db = testDb();
    markSlackMessageDeleted(db, {
      ...row({ text: "recovered from previous_message" }),
      deletedAt: 7,
    });
    const stored = getSlackMessage(db, "C1", "1000.0001");
    expect(stored?.text).toBe("recovered from previous_message");
    expect(stored?.deletedAt).toBe(7);
  });
});

describe("slackSyncState", () => {
  test("returns undefined for an unseen channel", () => {
    expect(getSlackSyncState(testDb(), "C1")).toBeUndefined();
  });

  test("partial patches merge without clobbering the untouched field", () => {
    const db = testDb();
    setSlackSyncState(db, "C1", { oldestBackfilled: "500.0000" });
    setSlackSyncState(db, "C1", { latestSeen: "999.0000" });
    const state = getSlackSyncState(db, "C1");
    expect(state?.oldestBackfilled).toBe("500.0000");
    expect(state?.latestSeen).toBe("999.0000");
  });
});
