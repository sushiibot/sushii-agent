import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { upsertSlackMessage, type SlackMessageRow } from "../../db/slackMessages.ts";
import { createSlackWikiSyncContext, makeSlackWikiSyncContext, type SlackWikiSyncClient } from "./wikiSync.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function row(overrides: Partial<SlackMessageRow> = {}): SlackMessageRow {
  return {
    channel: "C1",
    ts: "1000.0001",
    team: "T1",
    user: "U1",
    text: "hello",
    createdAt: 1000,
    rawJson: "{}",
    ingestedAt: 1,
    ...overrides,
  };
}

interface FakeClientOpts {
  users?: Record<string, { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }>;
  channels?: Record<string, { name?: string }>;
}

function fakeClient(opts: FakeClientOpts = {}): { client: SlackWikiSyncClient; userInfoCalls: string[]; posted: Array<{ channel: string; text: string }> } {
  const userInfoCalls: string[] = [];
  const posted: Array<{ channel: string; text: string }> = [];
  const client: SlackWikiSyncClient = {
    users: {
      async info({ user }) {
        userInfoCalls.push(user);
        const u = opts.users?.[user];
        if (!u) throw new Error("user_not_found");
        return { user: { id: user, ...u } };
      },
    },
    conversations: {
      async info({ channel }) {
        const c = opts.channels?.[channel];
        return c ? { channel: c } : {};
      },
    },
    chat: {
      async postMessage({ channel, text }) {
        posted.push({ channel, text });
        return { ts: "9999.0001" };
      },
      async update() {
        return {};
      },
    },
  };
  return { client, userInfoCalls, posted };
}

describe("createSlackWikiSyncContext.fetchUnprocessed", () => {
  test("maps rows to WikiSyncMessage, resolving + caching the author, and excludes bot/deleted/system messages", async () => {
    const db = testDb();
    upsertSlackMessage(db, row({ ts: "1.1", text: "first", user: "U1" }));
    upsertSlackMessage(db, row({ ts: "1.2", text: "second from same user", user: "U1", createdAt: 1001 }));
    upsertSlackMessage(db, row({ ts: "1.3", text: "a bot", botId: "B1", user: null, createdAt: 1002 }));
    upsertSlackMessage(db, row({ ts: "1.4", text: "joined", subtype: "channel_join", createdAt: 1003 }));
    upsertSlackMessage(db, row({ ts: "1.5", text: "deleted", deletedAt: 5, createdAt: 1004 }));
    upsertSlackMessage(db, row({ ts: "1.6", text: "other workspace", team: "T2", createdAt: 1005 }));

    const { client, userInfoCalls } = fakeClient({
      users: { U1: { name: "alice", real_name: "Alice A", profile: { display_name: "Ally" } } },
      channels: { C1: { name: "general" } },
    });
    const ctx = createSlackWikiSyncContext(client, "https://acme.slack.com/", { surface: "slack", spaceId: "T1" }, db);
    const msgs = await ctx.messages.fetchUnprocessed("T1", 0, 2000, 100);

    expect(msgs.map((m) => m.messageId)).toEqual(["1.1", "1.2"]);
    expect(msgs[0]).toMatchObject({
      surface: "slack",
      spaceId: "T1",
      channelId: "C1",
      parentChannelId: null,
      authorId: "U1",
      authorUsername: "alice",
      authorDisplayName: "Ally",
      content: "first",
      replyTo: null,
    });
    // Cached: two messages from U1 resolve the user exactly once.
    expect(userInfoCalls).toEqual(["U1"]);
    // Channel name populated during fetch and readable synchronously afterward.
    expect(ctx.channelNames.resolve("C1")).toBe("general");
  });

  test("falls back to the user id when users.info can't resolve", async () => {
    const db = testDb();
    upsertSlackMessage(db, row({ user: "Ughost" }));
    const { client } = fakeClient();
    const ctx = createSlackWikiSyncContext(client, "https://acme.slack.com/", { surface: "slack", spaceId: "T1" }, db);
    const msgs = await ctx.messages.fetchUnprocessed("T1", 0, 2000, 100);
    expect(msgs[0]).toMatchObject({ authorUsername: "Ughost", authorDisplayName: null });
  });

  test("builds replyTo from the thread root, and null when the root is absent", async () => {
    const db = testDb();
    upsertSlackMessage(db, row({ ts: "10.0", text: "the original question that started the thread", user: "U1", createdAt: 100 }));
    upsertSlackMessage(db, row({ ts: "10.5", text: "a reply", user: "U2", threadTs: "10.0", createdAt: 200 }));
    upsertSlackMessage(db, row({ ts: "10.9", text: "reply to a missing root", user: "U2", threadTs: "99.0", createdAt: 300 }));

    const { client } = fakeClient({
      users: { U1: { name: "alice", profile: { display_name: "Ally" } }, U2: { name: "bob" } },
    });
    const ctx = createSlackWikiSyncContext(client, "https://acme.slack.com/", { surface: "slack", spaceId: "T1" }, db);
    const msgs = await ctx.messages.fetchUnprocessed("T1", 0, 2000, 100);

    const reply = msgs.find((m) => m.messageId === "10.5");
    expect(reply?.replyTo).toEqual({ author: "Ally", content: "the original question that started the thread" });
    // The thread root itself isn't a reply (thread_ts === ts is unset here).
    expect(msgs.find((m) => m.messageId === "10.0")?.replyTo).toBeNull();
    // Root out of range → no replyTo.
    expect(msgs.find((m) => m.messageId === "10.9")?.replyTo).toBeNull();
  });

  test("truncates a long reply-root snippet at 120 chars with an ellipsis", async () => {
    const db = testDb();
    const long = "x".repeat(200);
    upsertSlackMessage(db, row({ ts: "20.0", text: long, user: "U1", createdAt: 100 }));
    upsertSlackMessage(db, row({ ts: "20.5", text: "reply", user: "U1", threadTs: "20.0", createdAt: 200 }));
    const { client } = fakeClient({ users: { U1: { name: "alice" } } });
    const ctx = createSlackWikiSyncContext(client, "https://acme.slack.com/", { surface: "slack", spaceId: "T1" }, db);
    const msgs = await ctx.messages.fetchUnprocessed("T1", 0, 2000, 100);
    expect(msgs.find((m) => m.messageId === "20.5")?.replyTo?.content).toBe(`${"x".repeat(120)}…`);
  });
});

describe("createSlackWikiSyncContext.linkFor", () => {
  test("builds the workspace archive permalink from channel + ts", () => {
    const { client } = fakeClient();
    const ctx = createSlackWikiSyncContext(client, "https://acme.slack.com/", { surface: "slack", spaceId: "T1" });
    const link = ctx.linkFor({
      surface: "slack",
      spaceId: "T1",
      messageId: "1700000000.001500",
      channelId: "C0ABC",
      parentChannelId: null,
      authorId: "U1",
      authorUsername: "alice",
      authorDisplayName: null,
      content: "hi",
      createdAt: 1,
      replyTo: null,
    });
    expect(link).toBe("https://acme.slack.com/archives/C0ABC/p1700000000001500");
  });
});

describe("createSlackWikiSyncContext.notify", () => {
  test("no-ops when the source has no status channel", async () => {
    const { client, posted } = fakeClient();
    const ctx = createSlackWikiSyncContext(client, "https://acme.slack.com/", { surface: "slack", spaceId: "T1" });
    await ctx.notify.postStatus({ repo: {} as never, commitSha: "abc" });
    expect(posted).toEqual([]);
  });
});

describe("makeSlackWikiSyncContext", () => {
  test("returns null for a non-slack source surface", () => {
    const { client } = fakeClient();
    expect(makeSlackWikiSyncContext(client, "https://acme.slack.com/", "w1", { surface: "discord", spaceId: "g1" }, testDb())).toBeNull();
  });

  test("builds a context for a slack source", () => {
    const { client } = fakeClient();
    expect(makeSlackWikiSyncContext(client, "https://acme.slack.com/", "w1", { surface: "slack", spaceId: "T1" }, testDb())).not.toBeNull();
  });
});
