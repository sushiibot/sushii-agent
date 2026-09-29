import { describe, expect, test } from "bun:test";
import type { MessageCreateOptions } from "discord.js";
import type { ChatMessageMode, ChatMessageParams } from "../../orchestration/contracts.ts";
import {
  CATCH_UP_LIMIT,
  advanceCursor,
  catchUpOwnerDms,
  handleOwnerDm,
  selectCatchUp,
  voiceEcho,
  type DmCursor,
  type OwnerDmDeps,
  type OwnerDmMessage,
} from "./ownerDm.ts";
import { OFFLINE_NOTICE } from "./workspaceLink.ts";

function fakeMessage(overrides: Partial<OwnerDmMessage> = {}) {
  const reactions: string[] = [];
  const sent: Array<string | MessageCreateOptions> = [];
  const msg: OwnerDmMessage = {
    id: "1000",
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

function fakeDeps(opts: { enabled?: boolean; connected?: boolean; mode?: ChatMessageMode; sendFails?: boolean } = {}) {
  const calls = {
    messages: [] as Array<Omit<ChatMessageParams, "principalId">>,
    aborts: 0,
    news: 0,
    inProcess: [] as Array<{ text: string; notice?: string }>,
    resets: 0,
    inbox: [] as Array<[string, string]>,
  };
  const deps: OwnerDmDeps = {
    workspaceEnabled: opts.enabled ?? true,
    transcriptionEnabled: true,
    link: {
      isConnected: () => opts.connected ?? true,
      sendMessage: async (input) => {
        calls.messages.push(input);
        if (opts.sendFails) throw new Error("chat/message timed out after 10000ms");
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
      recordOffline: (u, r) => calls.inbox.push([u, r]),
    },
    transcribe: async () => "remind me what we changed",
    runInProcess: async (_m, text, { notice }) => {
      calls.inProcess.push({ text, ...(notice ? { notice } : {}) });
      return "in-process reply";
    },
    resetInProcess: async () => {
      calls.resets++;
    },
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
    expect(calls.messages).toEqual([{ messageId: "1000", text: "check the wiki sync", kind: "user", author: { id: "owner-1", name: "drk" }, attachments }]);
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
  });

  test("a failed or timed-out chat/message falls back the same way", async () => {
    const { deps, calls } = fakeDeps({ sendFails: true });
    await handleOwnerDm(fakeMessage().msg, deps);
    expect(calls.messages).toHaveLength(1);
    expect(calls.inProcess).toEqual([{ text: "check the wiki sync", notice: OFFLINE_NOTICE }]);
    expect(calls.inbox).toHaveLength(1);
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

  test("!new while the workspace is offline resets the in-process conversation", async () => {
    const { deps, calls } = fakeDeps({ connected: false });
    await handleOwnerDm(fakeMessage({ content: "!clear" }).msg, deps);
    expect(calls.resets).toBe(1);
    expect(calls.news).toBe(0);
  });

  test("voice: echo is `-# 🎙️ <transcript>` and the text goes out with voice:true and no audio attachment", async () => {
    const { deps, calls } = fakeDeps();
    const audio = [{ url: "https://cdn/v.ogg", name: "voice-message.ogg", contentType: "audio/ogg" }];
    const { msg, sent } = fakeMessage({ content: "", isVoice: true, attachments: audio });
    await handleOwnerDm(msg, deps);
    expect(sent[0]).toBe("-# 🎙️ remind me what we changed");
    expect(voiceEcho("x")).toBe("-# 🎙️ x");
    expect(calls.messages).toEqual([{ messageId: "1000", text: "remind me what we changed", kind: "user", author: { id: "owner-1", name: "drk" }, voice: true }]);
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
    expect(fetchedAfter!).toEqual(["1000", CATCH_UP_LIMIT]);
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
