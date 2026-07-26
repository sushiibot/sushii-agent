import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  buildBudgetWarning,
  buildLimitNote,
  buildReasoningSalvage,
  buildToolSummaryFallback,
  extractSubmittedAnswer,
  pushAssistantTurn,
  usableText,
} from "./wrapup.ts";

describe("usableText", () => {
  test("keeps ordinary prose", () => {
    expect(usableText("  Here is what I found.  ")).toBe("Here is what I found.");
  });

  test("rejects empty and whitespace-only text", () => {
    expect(usableText("")).toBe("");
    expect(usableText("\n  \n")).toBe("");
  });

  test("rejects internal preambles so they fall through to the retry", () => {
    expect(usableText("[Internal: checking the profile first]")).toBe("");
    expect(usableText("  [Internal: thinking]\nmore")).toBe("");
  });
});

describe("pushAssistantTurn", () => {
  const responseMessages = [{ role: "assistant" as const, content: "raw sdk message" }];

  test("persists the raw response when there are no tool calls", () => {
    const messages: ModelMessage[] = [];
    pushAssistantTurn(messages, { text: "done", response: { messages: responseMessages } });
    expect(messages).toEqual(responseMessages);
  });

  test("substitutes plain text when the response carries unanswered tool calls", () => {
    const messages: ModelMessage[] = [];
    pushAssistantTurn(messages, {
      text: "partial findings",
      toolCalls: [{ toolName: "search_messages" }],
      response: { messages: responseMessages },
    });
    expect(messages).toEqual([{ role: "assistant", content: "partial findings" }]);
  });

  test("never persists an empty assistant turn", () => {
    const messages: ModelMessage[] = [];
    pushAssistantTurn(messages, {
      text: "   ",
      toolCalls: [{ toolName: "search_messages" }],
      response: { messages: responseMessages },
    });
    expect(messages).toEqual([{ role: "assistant", content: "(no response)" }]);
  });
});

describe("buildToolSummaryFallback", () => {
  test("dedupes repeated tool names", () => {
    const text = buildToolSummaryFallback(
      [{ name: "search_messages" }, { name: "search_messages" }, { name: "get_user_profile" }],
      "iterations",
    );
    expect(text).toContain("search_messages, get_user_profile");
    expect(text).not.toContain("search_messages, search_messages");
  });

  test("omits the tool list rather than emitting a dangling colon", () => {
    expect(buildToolSummaryFallback([], "iterations")).not.toContain("I ran");
  });

  test("names the same cause as the limit note", () => {
    expect(buildToolSummaryFallback([], "context")).toContain("ran out of room");
    expect(buildToolSummaryFallback([], "iterations")).toContain("step limit");
  });
});

describe("extractSubmittedAnswer", () => {
  test("reads text from a well-formed object input", () => {
    const text = extractSubmittedAnswer([{ toolName: "submit_final_answer", input: { text: "the finding" } }]);
    expect(text).toBe("the finding");
  });

  test("parses a JSON string input and reads .text", () => {
    const text = extractSubmittedAnswer([
      { toolName: "submit_final_answer", input: JSON.stringify({ text: "the finding" }) },
    ]);
    expect(text).toBe("the finding");
  });

  test("recovers prose from a truncated argument instead of showing JSON scaffolding", () => {
    const raw = '{"text": "Ban case summary\\n\\nWho: zeph, confirmed alt of';
    const text = extractSubmittedAnswer([{ toolName: "submit_final_answer", input: raw }]);
    expect(text).toBe("Ban case summary\n\nWho: zeph, confirmed alt of");
  });

  test("drops a dangling escape left by the cut so it can't swallow the next character", () => {
    const text = extractSubmittedAnswer([
      { toolName: "submit_final_answer", input: '{"text": "line one\\nline two\\' },
    ]);
    expect(text).toBe("line one\nline two");
  });

  test("passes through a raw string that was never JSON", () => {
    const text = extractSubmittedAnswer([{ toolName: "submit_final_answer", input: "just prose" }]);
    expect(text).toBe("just prose");
  });

  test("ignores calls with a different tool name but still checks the rest", () => {
    const text = extractSubmittedAnswer([
      { toolName: "search_messages", input: { query: "foo" } },
      { toolName: "submit_final_answer", input: { text: "the finding" } },
    ]);
    expect(text).toBe("the finding");
  });

  test("returns empty for an object input with no usable text", () => {
    const text = extractSubmittedAnswer([{ toolName: "submit_final_answer", input: { reason: "no text field" } }]);
    expect(text).toBe("");
  });

  test("returns empty when there are no tool calls", () => {
    expect(extractSubmittedAnswer(undefined)).toBe("");
    expect(extractSubmittedAnswer([])).toBe("");
  });

  test("returns empty for a JSON string input that parses to something without text", () => {
    const text = extractSubmittedAnswer([
      { toolName: "submit_final_answer", input: JSON.stringify({ reason: "no text field" }) },
    ]);
    expect(text).toBe("");
  });
});

describe("buildReasoningSalvage", () => {
  test("wraps reasoning text with a disclaimer prefix", () => {
    const text = buildReasoningSalvage("looked at u:123's messages, seems fine actually");
    expect(text).toContain("raw, unreviewed investigation notes");
    expect(text).toContain("looked at u:123's messages, seems fine actually");
  });

  test("never emits a Recommended action line", () => {
    const text = buildReasoningSalvage("some notes about the case");
    expect(text).not.toContain("Recommended action");
  });

  test("returns empty for blank reasoning", () => {
    expect(buildReasoningSalvage("")).toBe("");
    expect(buildReasoningSalvage("   \n ")).toBe("");
  });

  test("caps combined output length", () => {
    const long = "x".repeat(10000);
    const text = buildReasoningSalvage(long, 3500);
    expect(text.length).toBeLessThanOrEqual(3500);
  });
});

describe("user-facing notes", () => {
  test("limit note names the actual cause", () => {
    expect(buildLimitNote("iterations")).toContain("tool step limit");
    expect(buildLimitNote("context")).toContain("ran out of room");
  });

  test("budget warning pluralizes", () => {
    expect(buildBudgetWarning(5)).toContain("5 tool-calling steps left");
    expect(buildBudgetWarning(1)).toContain("1 tool-calling step left");
  });
});
