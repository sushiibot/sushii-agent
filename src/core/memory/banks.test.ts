import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
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

  // Hard wall: a community groups multiple surfaces. If a memory spaceId ever resolved through a
  // community, `sushii-space-<spaceId>` would merge public facts across Discord/Slack/buzz. The
  // banks are a pure function of the raw spaceId — a space that happens to belong to a community
  // keys identically to one that doesn't.
  test("a community-member space keys exactly like any other raw spaceId (no community merge)", () => {
    // "1000000000000000001" is dreamcatcher's discord space in the community fixture; its banks must
    // NOT collapse into a shared community id.
    expect(memoryBanks({ spaceId: "1000000000000000001", userId: "u1", isPrivate: false })).toEqual({
      read: ["sushii-space-1000000000000000001-user-u1", "sushii-space-1000000000000000001"],
      write: "sushii-space-1000000000000000001-user-u1",
    });
  });

  // Source-level guard: the behavioral test above stays green even if a future edit wires
  // resolveCommunity into agentCore's memoryScope. The real regression fails HERE — neither the
  // pure keying function nor the memory-scope owner may reach the community resolver.
  test("banks.ts and agentCore.ts never reference the community resolver", () => {
    const here = fileURLToPath(import.meta.url);
    const banksSrc = readFileSync(here.replace(/\.test\.ts$/, ".ts"), "utf8");
    const coreSrc = readFileSync(here.replace(/memory\/banks\.test\.ts$/, "agentCore.ts"), "utf8");
    for (const src of [banksSrc, coreSrc]) {
      expect(src).not.toContain("communities");
      expect(src).not.toContain("resolveCommunity");
    }
  });
});
