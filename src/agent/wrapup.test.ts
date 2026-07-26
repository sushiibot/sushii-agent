import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  buildBudgetWarning,
  buildLimitNote,
  buildToolSummaryFallback,
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
