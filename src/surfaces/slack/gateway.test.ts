import { describe, expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import type { AgentCore, AgentReply, AgentTurnResult, InboundMessage, SurfaceSession } from "../../core/contracts.ts";
import { startSlackAgentLoop, type SlackAgentClient } from "./gateway.ts";

const tick = () => new Promise((r) => setTimeout(r, 20));

function fakeReply(text = "hi there"): AgentReply {
  return { segments: [{ kind: "text", text }], usage: { model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextLimit: 1 }, toolTrace: [], cancelled: false };
}

/** Records inbounds and drives session.deliver so the full event→core→session→post path runs. */
function fakeCore(inbounds: { inbound: InboundMessage; session: SurfaceSession }[], reply = fakeReply()): AgentCore {
  return {
    async handleInbound(inbound, session): Promise<AgentTurnResult> {
      inbounds.push({ inbound, session });
      await session.deliver(reply);
      return { status: "completed", reply };
    },
    async resume() { return { status: "error", message: "n/a" }; },
    cancel() { return { status: "no-active-turn" }; },
  };
}

interface Recorder {
  posts: { channel: string; text: string; thread_ts?: string }[];
  reactions: { channel: string; timestamp: string; name: string }[];
}

function fakeClient(rec: Recorder, opts: { replies?: { user?: string; text?: string }[]; names?: Record<string, string> } = {}): SlackAgentClient {
  return {
    chat: {
      async postMessage(args) { rec.posts.push(args); return { ts: "reply.0001" }; },
      async update() { return {}; },
    },
    reactions: { async add(args) { rec.reactions.push(args); return {}; } },
    users: {
      async info({ user }) { return { user: { id: user, name: opts.names?.[user] ?? user, profile: { display_name: opts.names?.[user] } } }; },
    },
    conversations: {
      async replies() { return { messages: opts.replies }; },
    },
  };
}

/** Minimal Bolt App stand-in: records listeners by event name and lets a test emit to all of them
 *  (Bolt runs every registered listener for an event — the basis of Phase1/Phase2 coexistence). */
function fakeApp() {
  const handlers = new Map<string, ((arg: { event: unknown }) => Promise<void>)[]>();
  return {
    app: {
      event(name: string, handler: (arg: { event: unknown }) => Promise<void>) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    } as unknown as App,
    async emit(name: string, event: unknown) {
      for (const h of handlers.get(name) ?? []) await h({ event });
    },
  };
}

const deps = (core: AgentCore, client: SlackAgentClient) => ({ core, client, selfId: "UBOT", selfName: "sushii", teamId: "T123" });

describe("startSlackAgentLoop", () => {
  test("an app_mention builds an InboundMessage with the bot mention stripped, not private", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const rec: Recorder = { posts: [], reactions: [] };
    const h = fakeApp();
    startSlackAgentLoop(h.app, deps(fakeCore(inbounds), fakeClient(rec, { names: { U1: "Alice" } })));
    await h.emit("app_mention", { type: "app_mention", user: "U1", text: "<@UBOT> hello there", ts: "1000.0001", channel: "C1", team: "T123" });
    await tick();

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].inbound.conversation).toMatchObject({ surface: "slack", spaceId: "T123", conversationId: "1000.0001", isPrivate: false });
    expect(inbounds[0].inbound.author).toMatchObject({ surface: "slack", userId: "U1", username: "Alice" });
    expect(inbounds[0].inbound.text).toBe("hello there");
    expect(rec.posts).toEqual([{ channel: "C1", text: "hi there", thread_ts: "1000.0001" }]);
    expect(rec.reactions).toEqual([{ channel: "C1", timestamp: "1000.0001", name: "sushi" }]);
  });

  test("the labeled `<@UBOT|name>` mention form is stripped, label and all", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const rec: Recorder = { posts: [], reactions: [] };
    const h = fakeApp();
    startSlackAgentLoop(h.app, deps(fakeCore(inbounds), fakeClient(rec, { names: { U1: "Alice" } })));
    await h.emit("app_mention", { type: "app_mention", user: "U1", text: "<@UBOT|sushii> hello there", ts: "1100.0001", channel: "C1", team: "T123" });
    await tick();

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].inbound.text).toBe("hello there");
  });

  test("a DM message triggers with isPrivate true and no mention required", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const rec: Recorder = { posts: [], reactions: [] };
    const h = fakeApp();
    startSlackAgentLoop(h.app, deps(fakeCore(inbounds), fakeClient(rec)));
    await h.emit("message", { type: "message", channel_type: "im", user: "U2", text: "hey", ts: "2000.0001", channel: "D9" });
    await tick();

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].inbound.conversation.isPrivate).toBe(true);
    expect(inbounds[0].inbound.text).toBe("hey");
  });

  test("the bot's own DM reply is NOT re-processed (self-message loop guard)", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const h = fakeApp();
    startSlackAgentLoop(h.app, deps(fakeCore(inbounds), fakeClient({ posts: [], reactions: [] })));
    await h.emit("message", { type: "message", channel_type: "im", user: "UBOT", text: "my own reply", ts: "3000.0001", channel: "D9" });
    await h.emit("message", { type: "message", channel_type: "im", bot_id: "B1", text: "bot echo", ts: "3000.0002", channel: "D9" });
    await h.emit("message", { type: "message", channel_type: "im", subtype: "message_changed", ts: "3000.0003", channel: "D9" });
    await tick();
    expect(inbounds).toHaveLength(0);
  });

  test("a non-mention channel message does NOT trigger the agent loop but IS still ingested", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const ingested: unknown[] = [];
    const h = fakeApp();
    // Phase 1 ingestion registers first on the same app and archives everything.
    h.app.event("message", async ({ event }) => { ingested.push(event); });
    startSlackAgentLoop(h.app, deps(fakeCore(inbounds), fakeClient({ posts: [], reactions: [] })));

    const channelMsg = { type: "message", channel_type: "channel", user: "U3", text: "just chatting", ts: "4000.0001", channel: "C1" };
    await h.emit("message", channelMsg);
    await tick();
    expect(inbounds).toHaveLength(0); // agent loop stays quiet
    expect(ingested).toContainEqual(channelMsg); // ingestion still saw it (coexistence)
  });

  test("an empty completed reply is reported, never silent", async () => {
    const rec: Recorder = { posts: [], reactions: [] };
    const h = fakeApp();
    const core = fakeCore([], fakeReply("   "));
    startSlackAgentLoop(h.app, deps(core, fakeClient(rec)));
    await h.emit("app_mention", { type: "app_mention", user: "U1", text: "<@UBOT> hi", ts: "5000.0001", channel: "C1" });
    await tick();
    // deliver drops the blank; finalize posts the never-silent notice instead.
    const errNotice = rec.posts.find((p) => p.text.includes("wasn't able"));
    expect(errNotice).toBeDefined();
  });

  test("a turn error is reported to the thread, never silent", async () => {
    const rec: Recorder = { posts: [], reactions: [] };
    const h = fakeApp();
    const core: AgentCore = {
      async handleInbound(): Promise<AgentTurnResult> { return { status: "error", message: "boom" }; },
      async resume() { return { status: "error", message: "n/a" }; },
      cancel() { return { status: "no-active-turn" }; },
    };
    startSlackAgentLoop(h.app, deps(core, fakeClient(rec)));
    await h.emit("app_mention", { type: "app_mention", user: "U1", text: "<@UBOT> hi", ts: "6000.0001", channel: "C1" });
    await tick();
    expect(rec.posts.some((p) => p.text.includes("went wrong"))).toBe(true);
  });

  test("a threaded reply carries the parent message as replyTo and threads the response", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const rec: Recorder = { posts: [], reactions: [] };
    const h = fakeApp();
    startSlackAgentLoop(h.app, deps(fakeCore(inbounds), fakeClient(rec, { replies: [{ user: "U9", text: "the root question" }], names: { U9: "Bob" } })));
    await h.emit("app_mention", { type: "app_mention", user: "U1", text: "<@UBOT> follow-up", ts: "7000.0002", thread_ts: "7000.0001", channel: "C1" });
    await tick();
    expect(inbounds[0].inbound.replyTo).toMatchObject({ text: "the root question", author: { userId: "U9", username: "Bob" } });
    expect(inbounds[0].inbound.conversation.conversationId).toBe("7000.0001"); // threaded under root
    expect(rec.posts[0].thread_ts).toBe("7000.0001");
  });
});
