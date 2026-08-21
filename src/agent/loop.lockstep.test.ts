import { describe, expect, mock, test } from "bun:test";

// This file is deliberately separate from loop.test.ts: mock.module must replace "ai" before
// loop.ts's own `import { generateText } from "ai"` binding resolves, and loop.test.ts already
// imports loop.ts statically for its buildSystemPrompt suite — by the time any test in that file
// runs, the real generateText is already bound. Isolating the mock to its own file, and reaching
// loop.ts only via a dynamic import after the mock is installed, is what makes the substitution
// take effect at all.

interface CapturedCall {
  tools: Record<string, unknown> | undefined;
}

const calls: CapturedCall[] = [];

mock.module("ai", () => {
  const actual = require("ai") as typeof import("ai");
  return {
    ...actual,
    generateText: async (params: { tools?: Record<string, unknown> }) => {
      calls.push({ tools: params.tools });
      if (calls.length === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "1", toolName: "timeout_member", input: { user_id: "1", duration_ms: 60000 } }],
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 10 },
          response: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "1", toolName: "timeout_member", input: { user_id: "1", duration_ms: 60000 } }],
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

// Regression guard for the actual seam that makes "a tool outside enabled modules/auto-mod mode
// is unroutable" true in production: runAgentLoop computes toolEntries ONCE and feeds the same
// array to both buildAiTools (what the model is shown) and runTools (what can execute). This
// drives the real function end to end — unlike the resolveToolEntries- and runTools-level tests,
// which each pin one half of the lockstep separately — so a change that let runTools resolve
// through a differently-filtered list than what the model saw (e.g. `runTools(..., buildToolsForGuild(enabledModules), ...)`
// bypassing the auto-mod filter) would fail this test even though those other tests still pass.
describe("runAgentLoop tool lockstep", () => {
  test("an auto-mod-only tool is hidden from the model AND rejected by execution when autoModTrigger is unset", async () => {
    const fakeClient = { channels: { fetch: async () => null } } as unknown as import("discord.js").Client<true>;

    const result = await runAgentLoop(
      "please timeout this user",
      [],
      "guild1",
      fakeClient,
      ["moderation"],
      "You are a test assistant.",
      {},
    );

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(calls[0]!.tools ?? {})).not.toContain("timeout_member");

    const toolResultMsg = result.updatedHistory.find(
      (m) => m.role === "tool" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-result" && p.toolCallId === "1"),
    );
    expect(toolResultMsg).toBeDefined();
    const part = (toolResultMsg as { content: { type: string; toolCallId: string; output: { type: string; value: string } }[] }).content.find(
      (p) => p.toolCallId === "1",
    )!;
    expect(part.output.value).toBe("Unknown tool: timeout_member");
  });
});
