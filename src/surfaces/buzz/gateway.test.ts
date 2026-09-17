import { describe, expect, test } from "bun:test";
import type { AgentCore, AgentReply, AgentTurnResult, InboundMessage, SurfaceSession } from "../../core/contracts.ts";
import { startBuzzSurface, type CursorStore } from "./gateway.ts";
import type { BuzzClient, BuzzEvent, BuzzSendResult } from "./buzzClient.ts";

const tick = () => new Promise((r) => setTimeout(r, 15));

function event(overrides: Partial<BuzzEvent> = {}): BuzzEvent {
  return { id: "evt1", pubkey: "user1", kind: 9, content: "hey @sushii", createdAt: 1000, tags: [["h", "chan-uuid"]], ...overrides };
}

function fakeReply(): AgentReply {
  return { segments: [{ kind: "text", text: "hi there" }], usage: { model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextLimit: 1 }, toolTrace: [], cancelled: false };
}

/** Records inbounds and drives session.deliver so the full poll→core→session→send path is exercised. */
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

function fakeClient(
  events: BuzzEvent[],
  sends: { channelId: string; content: string; replyToId?: string }[],
  ownPubkey = "me",
  profiles?: string[],
): BuzzClient {
  return {
    async ownPubkey() { return ownPubkey; },
    async setProfile(name) { profiles?.push(name); },
    async feedMentions() { return events; },
    async send(channelId, content, replyToId): Promise<BuzzSendResult> {
      sends.push({ channelId, content, replyToId });
      return { eventId: "reply-evt", accepted: true };
    },
  };
}

function memCursor(initial = 0): CursorStore & { value: number } {
  const store = { value: initial, get() { return store.value; }, set(c: number) { store.value = c; } };
  return store;
}

describe("startBuzzSurface poll loop", () => {
  test("builds an InboundMessage from a mention and replies via the client", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const sends: { channelId: string; content: string; replyToId?: string }[] = [];
    const cursor = memCursor(500);
    const surface = await startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event({ createdAt: 1000 })], sends), cursor, pollIntervalMs: 10_000 });
    await tick();
    surface.stop();

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].inbound.conversation).toEqual({ surface: "buzz", spaceId: "buzz", conversationId: "evt1" });
    expect(inbounds[0].inbound.author).toMatchObject({ surface: "buzz", userId: "user1" });
    expect(inbounds[0].inbound.text).toBe("hey @sushii");
    expect(sends).toEqual([{ channelId: "chan-uuid", content: "hi there", replyToId: "evt1" }]);
    expect(cursor.value).toBe(1000); // advanced
  });

  test("ignores the agent's own messages (self-mention loop guard)", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const sends: { channelId: string; content: string; replyToId?: string }[] = [];
    const cursor = memCursor(500);
    const surface = await startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event({ pubkey: "me", createdAt: 1000 })], sends), cursor, pollIntervalMs: 10_000 });
    await tick();
    surface.stop();
    expect(inbounds).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  test("uses the NIP-10 root event id as the conversation key inside a thread", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const cursor = memCursor(500);
    const threaded = event({ id: "reply-in-thread", createdAt: 1000, tags: [["h", "chan-uuid"], ["e", "thread-root", "", "root"]] });
    const surface = await startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([threaded], []), cursor, pollIntervalMs: 10_000 });
    await tick();
    surface.stop();
    expect(inbounds[0].inbound.conversation.conversationId).toBe("thread-root");
  });

  test("skips a mention with no channel tag but still advances the cursor", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const cursor = memCursor(500);
    const noChannel = event({ createdAt: 1000, tags: [["e", "x"]] });
    const surface = await startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([noChannel], []), cursor, pollIntervalMs: 10_000 });
    await tick();
    surface.stop();
    expect(inbounds).toHaveLength(0);
    expect(cursor.value).toBe(1000);
  });

  test("publishes its display name on startup when one is configured", async () => {
    const profiles: string[] = [];
    const cursor = memCursor(500);
    const surface = await startBuzzSurface({ core: fakeCore([]), client: fakeClient([], [], "me", profiles), cursor, pollIntervalMs: 10_000, displayName: "sushii-agent" });
    await tick();
    surface.stop();
    expect(profiles).toEqual(["sushii-agent"]);
  });

  test("routes conversations into a per-relay space when spaceId is given", async () => {
    const inbounds: { inbound: InboundMessage; session: SurfaceSession }[] = [];
    const cursor = memCursor(500);
    const surface = await startBuzzSurface({ core: fakeCore(inbounds), client: fakeClient([event({ createdAt: 1000 })], []), cursor, pollIntervalMs: 10_000, spaceId: "buzz:wss://a" });
    await tick();
    surface.stop();
    expect(inbounds[0].inbound.conversation.spaceId).toBe("buzz:wss://a");
  });

  test("a fresh cursor (0) is initialized to ~now, skipping history", async () => {
    const cursor = memCursor(0);
    const before = Math.floor(Date.now() / 1000);
    const surface = await startBuzzSurface({ core: fakeCore([]), client: fakeClient([], []), cursor, pollIntervalMs: 10_000 });
    await tick();
    surface.stop();
    expect(cursor.value).toBeGreaterThanOrEqual(before);
  });
});
