import { expect, test } from "bun:test";
import { conversationContext } from "./piChatSession.ts";
import type { ChatSession } from "./personalSession.ts";

function session(tokens: number | null, messages: ChatSession["messages"] = []): ChatSession {
  return { getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }), messages, isStreaming: false, isCompacting: false } as ChatSession;
}

test("after compaction, current context estimates retained messages instead of old reply usage", () => {
  const s = session(null, [
    { role: "user", content: "New summary. ".repeat(100), timestamp: Date.now() },
    { role: "assistant", content: [{ type: "text", text: "Retained answer." }], usage: { input: 180_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 180_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: Date.now() },
  ]);
  const context = conversationContext(s)!;
  expect(context.estimated).toBe(true);
  expect(context.tokens).toBeGreaterThan(300);
  expect(context.tokens).toBeLessThan(2000);
  expect(context.percent).toBeLessThan(1);
  expect(conversationContext({ ...s, isCompacting: true })?.status).toBe("compacting");
});

test("current usage supersedes the estimate and follows running state", () => {
  const s = session(12000, [{ role: "assistant" } as ChatSession["messages"][number]]);
  expect(conversationContext(s)).toMatchObject({ tokens: 12000, percent: 6, estimated: false, status: "ready" });
  expect(conversationContext({ ...s, isStreaming: true })?.status).toBe("updating");
  expect(conversationContext(null)).toBeNull();
});
