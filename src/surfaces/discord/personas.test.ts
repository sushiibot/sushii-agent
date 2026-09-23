import { describe, expect, test } from "bun:test";
import { BEHAVIOR_INSTRUCTIONS } from "../../modules/moderation/prompt.ts";
import { DISCORD_FORMATTING } from "./conventions.ts";
import { GENERAL_BEHAVIOR, PERSONAL_BEHAVIOR, guildBehavior } from "./personas.ts";

describe("Discord personas", () => {
  test("a guild without promptTemplate keeps the moderation persona", () => {
    expect(guildBehavior({})).toBe(BEHAVIOR_INSTRUCTIONS);
    expect(guildBehavior({ promptTemplate: "moderation" })).toBe(BEHAVIOR_INSTRUCTIONS);
    expect(guildBehavior({ promptTemplate: "general" })).toBe(GENERAL_BEHAVIOR);
  });

  test("every persona carries the shared Discord formatting rules", () => {
    for (const p of [BEHAVIOR_INSTRUCTIONS, GENERAL_BEHAVIOR, PERSONAL_BEHAVIOR]) expect(p).toContain(DISCORD_FORMATTING);
  });

  test("the general and personal personas are not moderation assistants", () => {
    for (const p of [GENERAL_BEHAVIOR, PERSONAL_BEHAVIOR]) {
      expect(p).not.toContain("moderation intelligence assistant");
      expect(p).not.toContain("Recommended action");
    }
    expect(PERSONAL_BEHAVIOR).toContain("Runners section");
  });
});
