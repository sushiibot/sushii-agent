import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { parseFacts, lastUserText } from "./memoryDeriver.ts";

describe("memoryDeriver — parseFacts", () => {
  test("parses a plain facts object", () => {
    const out = parseFacts('{"facts":[{"content":"prefers dark mode","importance":0.6}]}');
    expect(out).toEqual([{ content: "prefers dark mode", importance: 0.6 }]);
  });

  test("strips a ```json code fence", () => {
    const out = parseFacts('```json\n{"facts":[{"content":"uses TypeScript"}]}\n```');
    expect(out).toEqual([{ content: "uses TypeScript", importance: undefined }]);
  });

  test("empty facts array yields nothing", () => {
    expect(parseFacts('{"facts":[]}')).toEqual([]);
  });

  test("junk / non-JSON yields nothing (never throws)", () => {
    expect(parseFacts("I could not find any facts.")).toEqual([]);
    expect(parseFacts("")).toEqual([]);
    expect(parseFacts('{"nope":true}')).toEqual([]);
  });

  test("filters out entries without a non-empty string content", () => {
    const out = parseFacts('{"facts":[{"content":"keep"},{"content":""},{"importance":0.9},{"content":"   "}]}');
    expect(out).toEqual([{ content: "keep", importance: undefined }]);
  });

  test("caps at 5 facts per turn", () => {
    const facts = Array.from({ length: 9 }, (_, i) => ({ content: `f${i}` }));
    const out = parseFacts(JSON.stringify({ facts }));
    expect(out).toHaveLength(5);
  });
});

describe("memoryDeriver — lastUserText", () => {
  test("returns the most recent string user message, trimmed", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "  most recent  " },
      { role: "assistant", content: "done" },
    ];
    expect(lastUserText(history)).toBe("most recent");
  });

  test("skips non-string (multimodal) user content and returns '' when none", () => {
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "image", image: "http://x" }] as unknown as string },
      { role: "assistant", content: "hi" },
    ];
    expect(lastUserText(history)).toBe("");
  });
});
