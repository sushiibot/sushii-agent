import { describe, expect, test } from "bun:test";
import { assembleSystemPrompt } from "./systemPrompt.ts";

describe("date note", () => {
  test("surfaces without Discord timestamps get a note that doesn't mention them", () => {
    expect(assembleSystemPrompt({ behavior: "b" })).toContain("Discord timestamp format");
    const plain = assembleSystemPrompt({ behavior: "b", plainTimestamps: true });
    expect(plain).toContain("Current date:");
    expect(plain).not.toContain("Discord");
  });
});
