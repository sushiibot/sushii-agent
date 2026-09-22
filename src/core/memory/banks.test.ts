import { describe, expect, test } from "bun:test";
import { memoryBanks } from "./banks.ts";

describe("memoryBanks", () => {
  test("private (DM) → DM bucket only, read == write", () => {
    expect(memoryBanks({ spaceId: "dm", userId: "u1", isPrivate: true })).toEqual({
      read: ["sushii-dm-u1"],
      write: "sushii-dm-u1",
    });
  });

  test("public space → individual bucket first, then space-general; write is the individual bucket", () => {
    expect(memoryBanks({ spaceId: "s1", userId: "u1", isPrivate: false })).toEqual({
      read: ["sushii-space-s1-user-u1", "sushii-space-s1"],
      write: "sushii-space-s1-user-u1",
    });
  });

  test("a private DM bank is never in a public read set (hard wall)", () => {
    const pub = memoryBanks({ spaceId: "s1", userId: "u1", isPrivate: false });
    expect(pub.read).not.toContain("sushii-dm-u1");
  });

  test("blank userId → no access, no write", () => {
    expect(memoryBanks({ spaceId: "s1", userId: "   ", isPrivate: false })).toEqual({ read: [], write: null });
  });

  test("blank spaceId → no access, no write", () => {
    expect(memoryBanks({ spaceId: "  ", userId: "u1", isPrivate: false })).toEqual({ read: [], write: null });
    expect(memoryBanks({ spaceId: "", userId: "u1", isPrivate: true })).toEqual({ read: [], write: null });
  });

  test("trims ids before keying", () => {
    expect(memoryBanks({ spaceId: " s1 ", userId: " u1 ", isPrivate: false })).toEqual({
      read: ["sushii-space-s1-user-u1", "sushii-space-s1"],
      write: "sushii-space-s1-user-u1",
    });
  });
});
