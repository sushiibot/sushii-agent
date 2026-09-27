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

describe("identity line", () => {
  test("defaults to the original Discord wording when selfSurface is omitted", () => {
    const text = assembleSystemPrompt({ behavior: "b", selfId: "BOT", selfName: "sushii" });
    expect(text).toContain("Your Discord user ID is BOT (sushii).");
  });

  test("names the actual surface for slack and buzz", () => {
    expect(assembleSystemPrompt({ behavior: "b", selfId: "BOT", selfSurface: "slack" })).toContain(
      "Your user ID on slack is BOT.",
    );
    expect(assembleSystemPrompt({ behavior: "b", selfId: "BOT", selfSurface: "buzz" })).toContain(
      "Your user ID on buzz is BOT.",
    );
  });
});

describe("caller section", () => {
  const author = { surface: "discord" as const, userId: "U1", username: "alice", isModerator: true, roles: [{ id: "R1", name: "Mod" }] };

  test("Moderator/Roles lines render by default (showModeratorRoles omitted)", () => {
    const text = assembleSystemPrompt({ behavior: "b", author });
    expect(text).toContain("Moderator: yes — has moderation role");
    expect(text).toContain("Roles: Mod (R1)");
  });

  test("Moderator/Roles lines are omitted when showModeratorRoles is false", () => {
    const text = assembleSystemPrompt({ behavior: "b", author, showModeratorRoles: false });
    expect(text).toContain("Request from: alice");
    expect(text).not.toContain("Moderator:");
    expect(text).not.toContain("Roles:");
  });

  test("a null username falls back to the userId instead of printing 'null'", () => {
    const text = assembleSystemPrompt({
      behavior: "b",
      author: { surface: "buzz", userId: "npub1abc", username: null },
      showModeratorRoles: false,
    });
    expect(text).toContain("Request from: npub1abc (u:npub1abc)");
    expect(text).not.toContain("null");
  });
});
