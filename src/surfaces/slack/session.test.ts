import { describe, expect, test } from "bun:test";
import { SlackSurfaceSession, type SlackPostClient } from "./session.ts";
import type { AgentReply } from "../../core/contracts.ts";

function fakeReply(text: string): AgentReply {
  return { segments: [{ kind: "text", text }], usage: { model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextLimit: 1 }, toolTrace: [], cancelled: false };
}

function fakeClient(posts: { channel: string; text: string; thread_ts?: string }[], ts = "9999.0001"): SlackPostClient {
  return {
    chat: {
      async postMessage(args) { posts.push(args); return { ts }; },
      async update() { return {}; },
    },
    reactions: { async add() { return {}; } },
    users: { async info() { return { user: {} }; } },
  };
}

const base = { selfId: "UBOT", selfName: "sushii", channelId: "C1", threadTs: "1000.0001" };

describe("SlackSurfaceSession", () => {
  test("deliver posts threaded under thread_ts and returns the delivered ts", async () => {
    const posts: { channel: string; text: string; thread_ts?: string }[] = [];
    const session = new SlackSurfaceSession({ client: fakeClient(posts), ...base });
    const res = await session.deliver(fakeReply("hi there"));
    expect(posts).toEqual([{ channel: "C1", text: "hi there", thread_ts: "1000.0001" }]);
    expect(res.messageId).toBe("9999.0001");
  });

  test("an empty reply is dropped (no post), like buzz", async () => {
    const posts: { channel: string; text: string; thread_ts?: string }[] = [];
    const session = new SlackSurfaceSession({ client: fakeClient(posts), ...base });
    const res = await session.deliver(fakeReply("   "));
    expect(posts).toHaveLength(0);
    expect(res.messageId).toBeUndefined();
  });

  test("interactive choices are gated off so the loop never deadlocks", () => {
    const session = new SlackSurfaceSession({ client: fakeClient([]), ...base });
    expect(session.capabilities.interactiveChoices).toBe(false);
    expect(session.capabilities.threads).toBe(true);
    expect(session.hosts.fs).toBeUndefined();
  });

  test("describeUser prefers the display name", () => {
    const session = new SlackSurfaceSession({ client: fakeClient([]), ...base });
    expect(session.renderer.describeUser({ surface: "slack", userId: "U1", username: "u1", displayName: "Alice" })).toBe("Alice");
  });
});
