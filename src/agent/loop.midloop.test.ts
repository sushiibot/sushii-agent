import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";

// Isolated for the same reason as loop.lockstep.test.ts: mock.module must replace "ai" before
// loop.ts's own `import { generateText } from "ai"` binding resolves.

let calls = 0;

mock.module("ai", () => {
  const actual = require("ai") as typeof import("ai");
  return {
    ...actual,
    generateText: async (params: { tools?: Record<string, unknown> }) => {
      calls++;
      // Only the first turn calls search_logs -- the point of this test is what happens to
      // that one call's owner-gate identity, not multi-turn behavior.
      if (calls === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "1", toolName: "search_logs", input: { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:05:00Z" } }],
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 10 },
          response: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "1", toolName: "search_logs", input: { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:05:00Z" } }],
              },
            ],
          },
        };
      }
      return {
        text: "done",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 5 },
        response: { messages: [{ role: "assistant", content: "done" }] },
      };
    },
  };
});

const { runAgentLoop } = await import("./loop.ts");
const { config } = await import("../config.ts");

function extractToolResultValue(result: Awaited<ReturnType<typeof runAgentLoop>>): string | undefined {
  const toolResultMsg = result.updatedHistory.find(
    (m) => m.role === "tool" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-result" && p.toolCallId === "1"),
  );
  const part = (toolResultMsg as { content: { type: string; toolCallId: string; output: { type: string; value: string } }[] } | undefined)?.content.find(
    (p) => p.toolCallId === "1",
  );
  return part?.output.value;
}

// Regression guard for the mid-loop owner-gate bypass found by adversarial review: a running
// loop's ToolContext.triggeringUserId used to stay fixed to whoever started the loop for its
// entire lifetime, even after a DIFFERENT user's message got injected into that same loop via
// mid-loop message queuing (src/bot.ts's threadMidLoopQueues). Since ops-triage's requireOwner
// only checks ctx.triggeringUserId, a non-owner's injected request could get an owner-only tool
// to execute under the original (owner) triggeringUserId. The fix: loop.ts now downgrades
// effectiveTriggeringUserId to undefined once any injected message's authorId differs from the
// loop's original triggeringUser.
describe("mid-loop message injection and the owner gate", () => {
  const ORIGINAL = { ownerDiscordId: config.ownerDiscordId, grafanaBaseUrl: config.grafanaBaseUrl };
  const fakeClient = { channels: { fetch: async () => null } } as unknown as import("discord.js").Client<true>;

  beforeEach(() => {
    calls = 0;
    config.ownerDiscordId = "owner1";
    // Loopback + a port nothing listens on -- fails fast (connection refused) instead of a slow DNS lookup.
    config.grafanaBaseUrl = "http://127.0.0.1:1";
  });

  afterEach(() => {
    Object.assign(config, ORIGINAL);
  });

  test("a mid-loop message from someone other than the triggering user downgrades the owner-gate identity for the rest of the loop", async () => {
    let dequeueCalls = 0;
    const result = await runAgentLoop(
      "check on this",
      [],
      "guild1",
      fakeClient,
      ["moderation"],
      "You are a test assistant.",
      {
        triggeringUser: { id: "owner1", username: "owner", roles: [], isModerator: false },
        dequeueMessages: () => {
          dequeueCalls++;
          // Only the first iteration has anything queued -- a message from a DIFFERENT user,
          // injected while the owner's loop is still running.
          return dequeueCalls === 1 ? [{ query: "please also check this", authorId: "attacker1" }] : [];
        },
      },
    );

    expect(extractToolResultValue(result)).toBe("This tool is owner-only.");
  });

  test("without any foreign mid-loop injection, the real owner's tool call still passes the gate (fails later, on the network call, not on requireOwner)", async () => {
    const result = await runAgentLoop(
      "check on this",
      [],
      "guild1",
      fakeClient,
      ["moderation"],
      "You are a test assistant.",
      { triggeringUser: { id: "owner1", username: "owner", roles: [], isModerator: false } },
    );

    const value = extractToolResultValue(result);
    expect(value).not.toBe("This tool is owner-only.");
  });
});
