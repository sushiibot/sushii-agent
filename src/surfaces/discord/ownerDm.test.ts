import { describe, expect, test } from "bun:test";
import type { MessageCreateOptions } from "discord.js";
import type { ChatMessageMode, ChatMessageParams } from "../../orchestration/contracts.ts";
import { RpcConnectionClosedError, RpcErrorReply, RpcTimeoutError, WorkspaceNotConnectedError } from "../../orchestration/transport/server.ts";
import {
  CATCH_UP_LIMIT,
  CATCH_UP_MAX_AGE_MS,
  CATCH_UP_PAGE_SIZE,
  advanceCursor,
  catchUpOwnerDms,
  handleOwnerDm,
  selectCatchUp,
  snowflakeAt,
  snowflakeCursor,
  type DmCursor,
  type OwnerDmDeps,
  type OwnerDmMessage,
} from "./ownerDm.ts";
import { routeDirectMessage } from "../../orchestration/workspace/router.ts";
import { DiscordOwnerDmSurface, NEW_WHILE_OFFLINE, OFFLINE_NOTICE, voiceEcho } from "./workspaceAdapter.ts";

const ORIGIN = { surface: "discord", conversationId: "dm-1" };

function fakeMessage(overrides: Partial<OwnerDmMessage> = {}) {
  const reactions: string[] = [];
  const sent: Array<string | MessageCreateOptions> = [];
  const msg: OwnerDmMessage = {
    id: "1000",
    channelId: "dm-1",
    content: "check the wiki sync",
    author: { id: "owner-1", name: "drk" },
    isVoice: false,
    attachments: [],
    react: async (e) => reactions.push(e),
    send: async (o) => sent.push(o),
    ...overrides,
  };
  return { msg, reactions, sent };
}

function memCursor(initial: string | null = null): DmCursor & { value: string | null } {
  const c = {
    value: initial,
    get: () => c.value,
    set: (id: string) => {
      c.value = id;
    },
  };
  return c;
}

function fakeDeps(
  opts: { enabled?: boolean; connected?: boolean; mode?: ChatMessageMode; sendError?: Error; sendErrors?: Error[]; connectedAfterFailure?: boolean } = {},
) {
  let connected = opts.connected ?? true;
  const queuedErrors = [...(opts.sendErrors ?? [])];
  const calls = {
    messages: [] as Array<Omit<ChatMessageParams, "principalId">>,
    aborts: 0,
    news: 0,
    inProcess: [] as Array<{ text: string; notice?: string }>,
    resets: 0,
    inbox: [] as Array<[string, string]>,
    inboxOrigins: [] as unknown[],
  };
  const deps: OwnerDmDeps = {
    workspaceEnabled: opts.enabled ?? true,
    transcriptionEnabled: true,
    link: {
      isConnected: () => connected,
      sendMessage: async (input) => {
        calls.messages.push(input);
        const queued = queuedErrors.shift();
        if (queued) throw queued;
        if (opts.sendError) {
          if (opts.connectedAfterFailure !== undefined) connected = opts.connectedAfterFailure;
          throw opts.sendError;
        }
        return { accepted: true, mode: opts.mode ?? "prompt" };
      },
      abort: async () => {
        calls.aborts++;
        return { aborted: true };
      },
      newSession: async () => {
        calls.news++;
        return { sessionFile: "s.jsonl" };
      },
      recordOffline: (u, r, origin) => {
        calls.inbox.push([u, r]);
        calls.inboxOrigins.push(origin);
      },
    },
    surface: new DiscordOwnerDmSurface({
      transcribe: async () => "remind me what we changed",
      runInProcess: async (_m, text, { notice }) => {
        calls.inProcess.push({ text, ...(notice ? { notice } : {}) });
        return "in-process reply";
      },
      resetInProcess: async () => {
        calls.resets++;
      },
    }),
    cursor: memCursor(),
  };
  return { deps, calls };
}

describe("owner DM routing", () => {
  test("flag off: the in-process path handles it, with no workspace call and no inbox row", async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const { msg, reactions } = fakeMessage();
    await handleOwnerDm(msg, deps);
    expect(calls.messages).toHaveLength(0);
    expect(calls.inProcess).toEqual([{ text: "check the wiki sync" }]);
    expect(calls.inbox).toHaveLength(0);
    expect(reactions).toEqual(["👀"]);
  });

  test("flag off: !new is the in-process reset and !stop is ordinary text", async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    await handleOwnerDm(fakeMessage({ content: "!new" }).msg, deps);
    await handleOwnerDm(fakeMessage({ id: "1001", content: "!stop" }).msg, deps);
    expect(calls.resets).toBe(1);
    expect(calls.news).toBe(0);
    expect(calls.aborts).toBe(0);
    expect(calls.inProcess.map((c) => c.text)).toEqual(["!stop"]);
  });

  test("connected: chat/message carries the discord id, text, author and attachments", async () => {
    const { deps, calls } = fakeDeps();
    const attachments = [{ url: "https://cdn/x.png", name: "x.png", contentType: "image/png" }];
    const { msg, reactions } = fakeMessage({ attachments });
    await handleOwnerDm(msg, deps);
    expect(calls.messages).toEqual([{ origin: ORIGIN, messageId: "1000", text: "check the wiki sync", kind: "user", author: { id: "owner-1", name: "drk" }, attachments }]);
    expect(calls.inProcess).toHaveLength(0);
    expect(reactions).toEqual(["👀"]);
  });

  test("reaction follows the mode: steer ↪️, duplicate nothing", async () => {
    const steer = fakeDeps({ mode: "steer" });
    const s = fakeMessage();
    await handleOwnerDm(s.msg, steer.deps);
    expect(s.reactions).toEqual(["↪️"]);

    const dup = fakeDeps({ mode: "duplicate" });
    const d = fakeMessage();
    await handleOwnerDm(d.msg, dup.deps);
    expect(d.reactions).toEqual([]);
    expect(dup.calls.inProcess).toHaveLength(0);
  });

  test("disconnected: in-process answer with the offline note, and the exchange lands in the inbox", async () => {
    const { deps, calls } = fakeDeps({ connected: false });
    await handleOwnerDm(fakeMessage().msg, deps);
    expect(calls.messages).toHaveLength(0);
    expect(calls.inProcess).toEqual([{ text: "check the wiki sync", notice: OFFLINE_NOTICE }]);
    expect(calls.inbox).toEqual([["check the wiki sync", "in-process reply"]]);
    expect(calls.inboxOrigins).toEqual([ORIGIN]);
  });

  test("a timeout while the workspace is still connected leaves the DM to the workspace: ⏳, no fallback", async () => {
    const { deps, calls } = fakeDeps({ sendError: new RpcTimeoutError("chat/message timed out after 10000ms") });
    deps.cursor = memCursor("900");
    const { msg, reactions, sent } = fakeMessage();
    await handleOwnerDm(msg, deps);
    expect(calls.messages).toHaveLength(1);
    expect(reactions).toEqual(["⏳"]);
    expect(calls.inProcess).toHaveLength(0);
    expect(calls.inbox).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(deps.cursor.get()).toBe("1000");
  });

  test("a timeout or closed socket after the workspace went away falls back", async () => {
    for (const err of [new RpcTimeoutError("timed out"), new RpcConnectionClosedError("connection closed")]) {
      const { deps, calls } = fakeDeps({ sendError: err, connectedAfterFailure: false });
      const { msg, reactions } = fakeMessage();
      await handleOwnerDm(msg, deps);
      expect(reactions).toEqual(["👀"]);
      expect(calls.inProcess).toEqual([{ text: "check the wiki sync", notice: OFFLINE_NOTICE }]);
      expect(calls.inbox).toHaveLength(1);
    }
  });

  test("a socket closed under a replacement connection retries once on the new one", async () => {
    const { deps, calls } = fakeDeps({ sendErrors: [new RpcConnectionClosedError("connection closed")], mode: "steer" });
    const { msg, reactions } = fakeMessage();
    await handleOwnerDm(msg, deps);
    expect(calls.messages.map((m) => m.messageId)).toEqual(["1000", "1000"]);
    expect(reactions).toEqual(["↪️"]);
    expect(calls.inProcess).toHaveLength(0);

    const again = fakeDeps({ sendErrors: [new RpcConnectionClosedError("connection closed"), new RpcTimeoutError("timed out")] });
    const second = fakeMessage();
    await handleOwnerDm(second.msg, again.deps);
    expect(again.calls.messages).toHaveLength(2);
    expect(second.reactions).toEqual(["⏳"]);
    expect(again.calls.inProcess).toHaveLength(0);

    const refused = fakeDeps({ sendErrors: [new RpcConnectionClosedError("connection closed"), new RpcErrorReply("nope", -32000)] });
    await handleOwnerDm(fakeMessage().msg, refused.deps);
    expect(refused.calls.inProcess).toEqual([{ text: "check the wiki sync", notice: OFFLINE_NOTICE }]);
  });

  test("a timeout is not retried", async () => {
    const { deps, calls } = fakeDeps({ sendErrors: [new RpcTimeoutError("timed out")] });
    await handleOwnerDm(fakeMessage().msg, deps);
    expect(calls.messages).toHaveLength(1);
  });

  test("an explicit RPC error or no connection means not accepted, so it falls back even while connected", async () => {
    for (const err of [new RpcErrorReply("personal session not started", -32000), new WorkspaceNotConnectedError("workspace not connected: drk")]) {
      const { deps, calls } = fakeDeps({ sendError: err });
      await handleOwnerDm(fakeMessage().msg, deps);
      expect(calls.inProcess).toEqual([{ text: "check the wiki sync", notice: OFFLINE_NOTICE }]);
      expect(calls.inbox).toHaveLength(1);
    }
  });

  test("!new → 🧠 + chat/new + ✅ New session.; !stop → chat/abort + ⏹", async () => {
    const { deps, calls } = fakeDeps();
    const n = fakeMessage({ content: " !RESET " });
    await handleOwnerDm(n.msg, deps);
    expect(calls.news).toBe(1);
    expect(n.reactions).toEqual(["🧠"]);
    expect(JSON.stringify((n.sent[0] as MessageCreateOptions).components?.map((c) => ("toJSON" in c ? c.toJSON() : c)))).toContain("✅ New session.");

    const s = fakeMessage({ id: "1001", content: "!stop" });
    await handleOwnerDm(s.msg, deps);
    expect(calls.aborts).toBe(1);
    expect(s.reactions).toEqual(["⏹️"]);
    expect(calls.messages).toHaveLength(0);
  });

  test("!new while the workspace is offline says its session is unchanged and clears nothing", async () => {
    const { deps, calls } = fakeDeps({ connected: false });
    const m = fakeMessage({ content: "!clear" });
    await handleOwnerDm(m.msg, deps);
    expect(calls.resets).toBe(0);
    expect(calls.news).toBe(0);
    expect(m.sent).toEqual([NEW_WHILE_OFFLINE]);
    expect(NEW_WHILE_OFFLINE).toContain("session is unchanged");
  });

  test("voice: echo is `-# 🎙️ <transcript>` and the text goes out with voice:true and no audio attachment", async () => {
    const { deps, calls } = fakeDeps();
    const audio = [{ url: "https://cdn/v.ogg", name: "voice-message.ogg", contentType: "audio/ogg" }];
    const { msg, sent } = fakeMessage({ content: "", isVoice: true, attachments: audio });
    await handleOwnerDm(msg, deps);
    expect(sent[0]).toBe("-# 🎙️ remind me what we changed");
    expect(voiceEcho("x")).toBe("-# 🎙️ x");
    expect(calls.messages).toEqual([{ origin: ORIGIN, messageId: "1000", text: "remind me what we changed", kind: "user", author: { id: "owner-1", name: "drk" }, voice: true }]);
  });

  test("voice on the in-process path uses the same echo", async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const { msg, sent } = fakeMessage({ content: "", isVoice: true });
    await handleOwnerDm(msg, deps);
    expect(sent[0]).toBe("-# 🎙️ remind me what we changed");
    expect(calls.inProcess).toEqual([{ text: "remind me what we changed" }]);
  });

  test("the cursor advances after each handled DM, on both paths, and never moves backward", async () => {
    const online = fakeDeps();
    await handleOwnerDm(fakeMessage({ id: "1005" }).msg, online.deps);
    expect(online.deps.cursor.get()).toBe("1005");

    const offline = fakeDeps({ connected: false });
    offline.deps.cursor = online.deps.cursor;
    await handleOwnerDm(fakeMessage({ id: "1010" }).msg, offline.deps);
    expect(online.deps.cursor.get()).toBe("1010");

    await handleOwnerDm(fakeMessage({ id: "1007" }).msg, offline.deps);
    expect(online.deps.cursor.get()).toBe("1010");
  });

  test("advanceCursor compares snowflakes numerically", () => {
    const c = memCursor("999999999999999999");
    advanceCursor(c, "1000000000000000000");
    expect(c.value).toBe("1000000000000000000");
    advanceCursor(c, "999999999999999999");
    expect(c.value).toBe("1000000000000000000");
  });
});

describe("DM catch-up on ready", () => {
  const NOW = 2_000_000_000_000;
  const owner = (id: string, ageMs = 1_000) => ({ id, createdTimestamp: NOW - ageMs, author: { id: "owner-1", bot: false } });

  test("handles owner DMs after the cursor oldest-first, skipping bots, others and anything older than 24h", async () => {
    const fetched = [
      owner("1030"),
      { id: "1025", createdTimestamp: NOW, author: { id: "bot", bot: true } },
      owner("1010"),
      { id: "1020", createdTimestamp: NOW, author: { id: "stranger", bot: false } },
      owner("1015", 25 * 60 * 60 * 1000),
      owner("1000"),
    ];
    const handled: string[] = [];
    let fetchedAfter: [string, number] | null = null;
    const count = await catchUpOwnerDms({
      cursor: "1000",
      ownerId: "owner-1",
      now: NOW,
      fetchAfter: async (after, limit) => {
        fetchedAfter = [after, limit];
        return fetched;
      },
      handle: async (m) => {
        handled.push(m.id);
      },
    });
    // The cursor is older than the 24h floor, so paging starts at the floor.
    expect(fetchedAfter!).toEqual([snowflakeAt(NOW - CATCH_UP_MAX_AGE_MS), CATCH_UP_PAGE_SIZE]);
    expect(handled).toEqual(["1010", "1030"]);
    expect(count).toBe(2);
  });

  test("routing caught-up DMs through the handler advances the cursor to the newest", async () => {
    const { deps } = fakeDeps();
    deps.cursor = memCursor("1000");
    await catchUpOwnerDms({
      cursor: deps.cursor.get(),
      ownerId: "owner-1",
      now: NOW,
      fetchAfter: async () => [owner("1003"), owner("1001"), owner("1002")],
      handle: (m) => handleOwnerDm(fakeMessage({ id: m.id }).msg, deps),
    });
    expect(deps.cursor.get()).toBe("1003");
  });

  test("a live DM handled before the fetch doesn't hide the backlog and isn't handled twice", async () => {
    const { deps, calls } = fakeDeps({ connected: false });
    deps.cursor = memCursor("1000");
    const cursorAtReady = deps.cursor.get();
    const handledLive = new Set<string>();
    // A live DM arrives while ready is still waiting for the workspace.
    handledLive.add("1005");
    await handleOwnerDm(fakeMessage({ id: "1005", content: "live" }).msg, deps);
    expect(deps.cursor.get()).toBe("1005");

    await catchUpOwnerDms({
      cursor: cursorAtReady,
      ownerId: "owner-1",
      now: NOW,
      fetchAfter: async () => [owner("1005"), owner("1002"), owner("1001")],
      handle: (m) => handleOwnerDm(fakeMessage({ id: m.id, content: `backlog ${m.id}` }).msg, deps),
      alreadyHandled: (id) => handledLive.has(id),
    });
    expect(calls.inProcess.map((c) => c.text)).toEqual(["live", "backlog 1001", "backlog 1002"]);
    expect(deps.cursor.get()).toBe("1005");
  });

  /** A DM channel that honours Discord's `after`/`limit`: the oldest `limit` messages after `after`, newest first. */
  function fakeChannel(messages: Array<ReturnType<typeof owner>>) {
    const calls: Array<[string, number]> = [];
    return {
      calls,
      fetchAfter: async (after: string, limit: number) => {
        calls.push([after, limit]);
        return messages
          .filter((m) => BigInt(m.id) > BigInt(after))
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          .slice(0, limit)
          .reverse();
      },
    };
  }

  test("pages past the bot's own messages to reach the owner's recent DMs, from the 24h floor", async () => {
    const base = BigInt(snowflakeAt(NOW - 60 * 60 * 1000));
    const bot = (i: number) => ({ id: (base + BigInt(i)).toString(), createdTimestamp: NOW - 3_000_000, author: { id: "bot", bot: true } });
    const msgs = [
      ...Array.from({ length: 150 }, (_, i) => bot(i)),
      ...[200, 201, 202].map((i) => ({ ...owner((base + BigInt(i)).toString()) })),
    ];
    const ch = fakeChannel(msgs);
    const handled: string[] = [];
    const staleCursor = snowflakeAt(NOW - 3 * CATCH_UP_MAX_AGE_MS);
    const count = await catchUpOwnerDms({ cursor: staleCursor, ownerId: "owner-1", now: NOW, fetchAfter: ch.fetchAfter, handle: async (m) => void handled.push(m.id) });
    expect(count).toBe(3);
    expect(handled).toEqual([200, 201, 202].map((i) => (base + BigInt(i)).toString()));
    expect(ch.calls[0]).toEqual([snowflakeAt(NOW - CATCH_UP_MAX_AGE_MS), CATCH_UP_PAGE_SIZE]);
    expect(ch.calls.length).toBe(2);
  });

  test("the cap counts owner DMs only, and stops paging once reached", async () => {
    const base = BigInt(snowflakeAt(NOW - 60 * 60 * 1000));
    const msgs = Array.from({ length: 250 }, (_, i) =>
      i % 2 ? owner((base + BigInt(i)).toString()) : { id: (base + BigInt(i)).toString(), createdTimestamp: NOW - 1000, author: { id: "bot", bot: true } },
    );
    const ch = fakeChannel(msgs);
    const handled: string[] = [];
    await catchUpOwnerDms({ cursor: base.toString(), ownerId: "owner-1", now: NOW, fetchAfter: ch.fetchAfter, handle: async (m) => void handled.push(m.id) });
    expect(handled).toHaveLength(CATCH_UP_LIMIT);
    expect(handled[0]).toBe((base + 1n).toString());
    expect(ch.calls.length).toBe(1);
  });

  test("routeDirectMessage hands owner DMs to the owner router and advances the cursor; others are ignored", async () => {
    const cursor = memCursor("1000");
    const seen: string[] = [];
    const owned: string[] = [];
    await routeDirectMessage(
      { id: "1004" },
      { isOwner: true, handleOwner: async (m) => void owned.push(m.id), cursor: snowflakeCursor(cursor), onOwnerDm: (id) => seen.push(id) },
    );
    expect(owned).toEqual(["1004"]);
    expect(cursor.get()).toBe("1004");
    expect(seen).toEqual(["1004"]);
    await routeDirectMessage({ id: "1009" }, { isOwner: false, handleOwner: async (m) => void owned.push(m.id), cursor: snowflakeCursor(cursor), onOwnerDm: (id) => seen.push(id) });
    expect(owned).toEqual(["1004"]);
    expect(cursor.get()).toBe("1004");
    expect(seen).toEqual(["1004"]);
  });

  test("no cursor yet: nothing is fetched", async () => {
    let fetched = false;
    const count = await catchUpOwnerDms({
      cursor: null,
      ownerId: "owner-1",
      now: NOW,
      fetchAfter: async () => {
        fetched = true;
        return [];
      },
      handle: async () => {},
    });
    expect(fetched).toBe(false);
    expect(count).toBe(0);
    expect(selectCatchUp([owner("5")], { cursor: null, ownerId: "owner-1", now: NOW })).toEqual([]);
  });
});
