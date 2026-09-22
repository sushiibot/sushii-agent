import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { createSummarizeFoldCompactor } from "./summarizeFold.ts";

const CONTEXT_LIMIT = 1_000;

/** Enough content to exceed ratio * contextLimit under the JSON-length/4 heuristic. */
function bulky(role: ModelMessage["role"], tag: string): ModelMessage {
  return { role, content: `${tag} ${"x".repeat(400)}` } as ModelMessage;
}

describe("createSummarizeFoldCompactor", () => {
  test("under budget → compacted:false, history unchanged", async () => {
    const summarize = async () => "SUMMARY";
    const compactor = createSummarizeFoldCompactor({ summarize });
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const out = await compactor.maybeCompact({ messages, contextLimit: CONTEXT_LIMIT });

    expect(out.compacted).toBe(false);
    expect(out.factCandidates).toEqual([]);
    expect(out.messages).toBe(messages);
  });

  test("over budget → compacted:true, tail verbatim, exactly one leading system summary", async () => {
    let summarizedCount = 0;
    const summarize = async (older: ModelMessage[]) => {
      summarizedCount = older.length;
      return "SUMMARY";
    };
    const compactor = createSummarizeFoldCompactor({ summarize, tailTurns: 2 });

    // 4 user turns; each turn = user + assistant. tailTurns=2 keeps the last two turns (indices 4..7).
    const messages: ModelMessage[] = [
      bulky("user", "u1"),
      bulky("assistant", "a1"),
      bulky("user", "u2"),
      bulky("assistant", "a2"),
      bulky("user", "u3"),
      bulky("assistant", "a3"),
      bulky("user", "u4"),
      bulky("assistant", "a4"),
    ];

    const out = await compactor.maybeCompact({ messages, contextLimit: CONTEXT_LIMIT });

    expect(out.compacted).toBe(true);
    expect(summarizedCount).toBe(4); // the first two turns were folded
    expect(out.messages[0]).toEqual({ role: "system", content: "SUMMARY" });
    // Exactly one leading system summary; the rest is the verbatim tail.
    expect(out.messages.filter((m) => m.role === "system").length).toBe(1);
    expect(out.messages.slice(1)).toEqual(messages.slice(4));
  });

  test("tool-call/tool-result pairing preserved across a fold (no orphaned tool_call_id)", async () => {
    const summarize = async () => "SUMMARY";
    const compactor = createSummarizeFoldCompactor({ summarize, tailTurns: 1 });

    const assistantWithCall: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-call", toolCallId: "call-1", toolName: "search", input: {} },
      ] as unknown as ModelMessage["content"],
    } as ModelMessage;
    const toolResult: ModelMessage = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-1", toolName: "search", output: { type: "text", value: "r" } },
      ] as unknown as ModelMessage["content"],
    } as ModelMessage;

    // Turn 1: user → assistant(toolCall) → tool. Turn 2: user → assistant. tailTurns=1 keeps turn 2,
    // so turn 1 (with its tool-call/result pair) is what gets folded — the fold must not split the pair.
    const messages: ModelMessage[] = [
      bulky("user", "u1"),
      assistantWithCall,
      toolResult,
      bulky("user", "u2"),
      bulky("assistant", "a2"),
    ];

    const out = await compactor.maybeCompact({ messages, contextLimit: 200 });

    expect(out.compacted).toBe(true);
    expect(out.messages[0].role).toBe("system");
    // Tail starts at a user boundary.
    expect(out.messages[1].role).toBe("user");

    // Every tool-result in the output has its originating assistant tool-call present.
    const callIds = new Set<string>();
    for (const m of out.messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content as { type: string; toolCallId?: string }[]) {
          if (p.type === "tool-call" && p.toolCallId) callIds.add(p.toolCallId);
        }
      }
    }
    for (const m of out.messages) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const p of m.content as { type: string; toolCallId?: string }[]) {
          if (p.type === "tool-result") {
            expect(p.toolCallId && callIds.has(p.toolCallId)).toBe(true);
          }
        }
      }
    }
  });

  test("over budget but no fold boundary older than the tail → compacted:false", async () => {
    const summarize = async () => "SUMMARY";
    const compactor = createSummarizeFoldCompactor({ summarize, tailTurns: 10 });
    // A single oversized user turn: nothing older than the kept tail to fold.
    const messages: ModelMessage[] = [bulky("user", "huge"), bulky("assistant", "reply")];

    // Low limit so the pair is over budget, forcing the boundary check rather than the budget check.
    const out = await compactor.maybeCompact({ messages, contextLimit: 300 });

    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(messages);
  });
});
