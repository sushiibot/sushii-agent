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

  test("private + linked principal → write is the principal bank; read unions the per-identity DM banks", () => {
    const banks = memoryBanks({
      spaceId: "T1",
      userId: "U0OWNERTEST0", // the current (slack) identity
      isPrivate: true,
      principalId: "drk",
      aliasUserIds: ["100000000000000000", "4fe70a"],
    });
    expect(banks.write).toBe("sushii-dm-principal-drk");
    expect(banks.read).toEqual([
      "sushii-dm-principal-drk",
      "sushii-dm-U0OWNERTEST0",
      "sushii-dm-100000000000000000",
      "sushii-dm-4fe70a",
    ]);
  });

  test("private + no principalId → unchanged single-identity DM bucket", () => {
    expect(memoryBanks({ spaceId: "dm", userId: "u9", isPrivate: true, aliasUserIds: ["x"] })).toEqual({
      read: ["sushii-dm-u9"],
      write: "sushii-dm-u9",
    });
  });

  test("public space ignores principal aliasing entirely (wall intact for a linked principal)", () => {
    const pub = memoryBanks({
      spaceId: "s1",
      userId: "u1",
      isPrivate: false,
      principalId: "drk",
      aliasUserIds: ["100000000000000000"],
    });
    expect(pub).toEqual({ read: ["sushii-space-s1-user-u1", "sushii-space-s1"], write: "sushii-space-s1-user-u1" });
    expect(pub.read.some((b) => b.startsWith("sushii-dm-"))).toBe(false);
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
