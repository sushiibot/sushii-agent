import { describe, expect, test } from "bun:test";
import type { AgentReply, AgentTurnResult, InboundMessage, SurfaceSession } from "../../core/contracts.ts";
import { startBuzzSurface, type CursorStore, type ServerContextStore } from "./gateway.ts";
import type { BuzzChannel, BuzzClient, BuzzEvent, BuzzSendResult, PresenceStatus } from "./buzzClient.ts";
import type { AgentCore } from "../../core/contracts.ts";

const tick = () => new Promise((r) => setTimeout(r, 20));

function event(overrides: Partial<BuzzEvent> = {}): BuzzEvent {
  return { id: "evt1", pubkey: "user1", kind: 9, content: "hey @sushii", createdAt: 1000, tags: [["h", "chan-uuid"]], ...overrides };
}

function fakeReply(): AgentReply {
  return { segments: [{ kind: "text", text: "hi there" }], usage: { model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextLimit: 1 }, toolTrace: [], cancelled: false };
}

/** Records inbounds and drives session.deliver so the full subscribe→core→session→send path runs. */
function fakeCore(inbounds: { inbound: InboundMessage; session: SurfaceSession }[]): AgentCore {
  return {
    async handleInbound(inbound, session): Promise<AgentTurnResult> {
      inbounds.push({ inbound, session });
      await session.deliver(fakeReply());
      return { status: "completed", reply: fakeReply() };
    },
    async resume() { return { status: "error", message: "n/a" }; },
    cancel() { return { status: "no-active-turn" }; },
  };
}

interface FakeClientOpts {
  ownPubkey?: string;
  profiles?: string[];
  presence?: PresenceStatus[];
  reactions?: { eventId: string; emoji: string }[];
  channels?: BuzzChannel[];
  channelsThrow?: boolean;
  channelsCalls?: { n: number };
  subscribedSince?: { value: number };
}

function fakeClient(
  events: BuzzEvent[],
  sends: { channelId: string; content: string; replyToId?: string }[],
  opts: FakeClientOpts = {},
): BuzzClient {
  const self = opts.ownPubkey ?? "me";
  return {
    async ownPubkey() { return self; },
    async setProfile(name) { opts.profiles?.push(name); },
    async setPresence(status) { opts.presence?.push(status); },
    subscribeMentions(sinceTs, onEvent) {
      if (opts.subscribedSince) opts.subscribedSince.value = sinceTs;
      // Mirror the real client: skip our own events, deliver the rest.
      for (const e of events) if (e.pubkey !== self) void onEvent(e);
      return { stop: () => {} };
    },
    async send(channelId, content, replyToId): Promise<BuzzSendResult> {
      sends.push({ channelId, content, replyToId });
      return { eventId: "reply-evt", accepted: true };
    },
    async react(eventId, emoji) { opts.reactions?.push({ eventId, emoji }); },
    async channelsList() {
      if (opts.channelsCalls) opts.channelsCalls.n++;
      if (opts.channelsThrow) throw new Error("not admitted");
      return opts.channels ?? [];
    },
  };
}

function memCursor(initial = 0): CursorStore & { value: number } {
  const store = { value: initial, get() { return store.value; }, set(c: number) { store.value = c; } };
  return store;
}

/** Fresh server-context port; starts null (first-run) unless seeded. */
function memServerContext(initial: string | null = null): ServerContextStore & { value: string | null } {
  const store = { value: initial, get() { return store.value; }, set(c: string) { store.value = c; } };
  return store;
}

describe("startBuzzSurface subscription", () => {
  test("builds an InboundMessage from a mention and replies via the client", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const sends: { channelId: string; content: string; replyToId?: string }[] = [];
    const cursor = memCursor(500);
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event()], sends), cursor, serverContext: memServerContext() });
    await tick();
    surface.stop();

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].inbound.conversation).toEqual({ surface: "buzz", spaceId: "buzz", conversationId: "evt1" });
    expect(inbounds[0].inbound.author).toMatchObject({ surface: "buzz", userId: "user1" });
    expect(inbounds[0].inbound.text).toBe("hey @sushii");
    expect(sends).toEqual([{ channelId: "chan-uuid", content: "hi there", replyToId: "evt1" }]);
    expect(cursor.value).toBe(1000); // advanced after handling
  });

  test("ignores the agent's own messages (self-mention loop guard)", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const sends: { channelId: string; content: string; replyToId?: string }[] = [];
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event({ pubkey: "me" })], sends), cursor: memCursor(500), serverContext: memServerContext() });
    await tick();
    surface.stop();
    expect(inbounds).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  test("uses the NIP-10 root event id as the conversation key inside a thread", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const threaded = event({ id: "reply-in-thread", tags: [["h", "chan-uuid"], ["e", "thread-root", "", "root"]] });
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([threaded], []), cursor: memCursor(500), serverContext: memServerContext() });
    await tick();
    surface.stop();
    expect(inbounds[0].inbound.conversation.conversationId).toBe("thread-root");
  });

  test("replies to the thread root, not the mention, so nesting stays one level deep", async () => {
    const sends: { channelId: string; content: string; replyToId?: string }[] = [];
    const threaded = event({ id: "reply-in-thread", tags: [["h", "chan-uuid"], ["e", "thread-root", "", "root"]] });
    const surface = startBuzzSurface({ core: fakeCore([]), client: fakeClient([threaded], sends), cursor: memCursor(500), serverContext: memServerContext() });
    await tick();
    surface.stop();
    expect(sends[0].replyToId).toBe("thread-root");
  });

  test("reacts with the sushi ack on the mention it picked up", async () => {
    const reactions: { eventId: string; emoji: string }[] = [];
    const surface = startBuzzSurface({ core: fakeCore([]), client: fakeClient([event()], [], { reactions }), cursor: memCursor(500), serverContext: memServerContext() });
    await tick();
    surface.stop();
    expect(reactions).toEqual([{ eventId: "evt1", emoji: "🍣" }]);
  });

  test("skips a mention with no channel tag", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const noChannel = event({ tags: [["e", "x"]] });
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([noChannel], []), cursor: memCursor(500), serverContext: memServerContext() });
    await tick();
    surface.stop();
    expect(inbounds).toHaveLength(0);
  });

  test("publishes display name and goes online on startup", async () => {
    const profiles: string[] = [];
    const presence: PresenceStatus[] = [];
    const surface = startBuzzSurface({ core: fakeCore([]), client: fakeClient([], [], { profiles, presence }), cursor: memCursor(500), serverContext: memServerContext(), displayName: "sushii-agent" });
    await tick();
    surface.stop();
    expect(profiles).toEqual(["sushii-agent"]);
    expect(presence[0]).toBe("online");
  });

  test("routes conversations into a per-relay space when spaceId is given", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event()], []), cursor: memCursor(500), serverContext: memServerContext(), spaceId: "buzz:wss://a" });
    await tick();
    surface.stop();
    expect(inbounds[0].inbound.conversation.spaceId).toBe("buzz:wss://a");
  });

  test("a fresh cursor (0) is initialized to ~now and used as the subscription since", async () => {
    const cursor = memCursor(0);
    const subscribedSince = { value: -1 };
    const before = Math.floor(Date.now() / 1000);
    const surface = startBuzzSurface({ core: fakeCore([]), client: fakeClient([], [], { subscribedSince }), cursor, serverContext: memServerContext() });
    await tick();
    surface.stop();
    expect(cursor.value).toBeGreaterThanOrEqual(before);
    expect(subscribedSince.value).toBeGreaterThanOrEqual(before);
  });

  test("scans the community into server context on first contact, before answering", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const ctx = memServerContext(null);
    const channels: BuzzChannel[] = [
      { id: "c1", name: "general", topic: "chit-chat" },
      { id: "c2", name: "dev" },
    ];
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event()], [], { channels }), cursor: memCursor(500), serverContext: ctx });
    await tick();
    surface.stop();
    expect(ctx.value).toContain("#general (`c1`): chit-chat");
    expect(ctx.value).toContain("#dev (`c2`)");
    expect(inbounds).toHaveLength(1);
  });

  test("does not rescan when server context already exists", async () => {
    const ctx = memServerContext("already scanned");
    const channelsCalls = { n: 0 };
    const surface = startBuzzSurface({ core: fakeCore([]), client: fakeClient([event()], [], { channelsCalls }), cursor: memCursor(500), serverContext: ctx });
    await tick();
    surface.stop();
    expect(channelsCalls.n).toBe(0);
    expect(ctx.value).toBe("already scanned");
  });

  test("a failed scan does not block the turn and is not retried per-mention", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const ctx = memServerContext(null);
    const channelsCalls = { n: 0 };
    const events = [event({ id: "evt1", createdAt: 1000 }), event({ id: "evt2", createdAt: 1001 })];
    const surface = startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient(events, [], { channelsThrow: true, channelsCalls }), cursor: memCursor(500), serverContext: ctx });
    await tick();
    surface.stop();
    expect(ctx.value).toBeNull();
    expect(inbounds).toHaveLength(2); // both turns still handled
    expect(channelsCalls.n).toBe(1); // attempted once, not per-mention
  });
});
