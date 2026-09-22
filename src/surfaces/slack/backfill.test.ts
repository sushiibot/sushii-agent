import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { getSlackSyncState } from "../../db/slackMessages.ts";
import { backfillWorkspace, type SlackReadClient } from "./backfill.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fakeClient(): { client: SlackReadClient; historyCursors: (string | undefined)[] } {
  const historyCursors: (string | undefined)[] = [];
  const client: SlackReadClient = {
    conversations: {
      async list() {
        return { channels: [{ id: "C1", is_member: true }, { id: "C2", is_member: false }] };
      },
      async history(args) {
        historyCursors.push(args.cursor);
        if (!args.cursor) {
          return {
            messages: [
              { type: "message", ts: "300.0000", user: "U1", text: "parent", thread_ts: "300.0000", reply_count: 1 },
              { type: "message", ts: "200.0000", user: "U2", text: "mid" },
            ],
            response_metadata: { next_cursor: "page2" },
          };
        }
        return { messages: [{ type: "message", ts: "100.0000", user: "U3", text: "oldest" }] };
      },
      async replies() {
        return {
          messages: [
            { type: "message", ts: "300.0000", user: "U1", text: "parent", thread_ts: "300.0000" },
            { type: "message", ts: "250.0000", user: "U4", text: "reply", thread_ts: "300.0000" },
          ],
        };
      },
    },
  };
  return { client, historyCursors };
}

describe("backfillWorkspace", () => {
  test("paginates history, fetches thread replies, and advances the sync cursor", async () => {
    const db = testDb();
    const { client, historyCursors } = fakeClient();

    await backfillWorkspace(client, db, { delayMs: 0 });

    // 300, 200 (page 1), 100 (page 2), plus 250 from the thread → 4 distinct rows, all in C1.
    const rows = db.query("SELECT ts FROM slack_messages ORDER BY ts").all() as { ts: string }[];
    expect(rows.map((r) => r.ts)).toEqual(["100.0000", "200.0000", "250.0000", "300.0000"]);

    // Only the member channel (C1) was crawled, so no rows attributed elsewhere.
    const channels = db.query("SELECT DISTINCT channel FROM slack_messages").all() as { channel: string }[];
    expect(channels.map((c) => c.channel)).toEqual(["C1"]);

    // Second history page was requested with the cursor from the first page.
    expect(historyCursors).toEqual([undefined, "page2"]);

    const state = getSlackSyncState(db, "C1");
    expect(state?.oldestBackfilled).toBe("100.0000");
    expect(state?.latestSeen).toBe("300.0000");
  });

  test("re-running is idempotent (no duplicate rows)", async () => {
    const db = testDb();
    await backfillWorkspace(fakeClient().client, db, { delayMs: 0 });
    await backfillWorkspace(fakeClient().client, db, { delayMs: 0 });
    const count = db.query("SELECT COUNT(*) AS n FROM slack_messages").get() as { n: number };
    expect(count.n).toBe(4);
  });
});
