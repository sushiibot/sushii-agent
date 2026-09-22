import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { CommunityConfig } from "./communities.ts";
import { buildCommunityIndex, isCommunityMember, resolveCommunity } from "./communities.ts";

// Placeholder ids only — never real guild/team ids in a public repo.
const COMMUNITIES: Record<string, CommunityConfig> = {
  dreamcatcher: {
    spaces: [
      { surface: "discord", spaceId: "1000000000000000001" },
      { surface: "slack", spaceId: "T000TEAMA0" },
    ],
    wiki: { wikiId: "1000000000000000001" },
    linear: { apiKey: "dc-key", teamId: "DREAM" },
    members: { "member-a": { trusted: true }, "member-b": { trusted: false } },
  },
  other: {
    spaces: [{ surface: "discord", spaceId: "1000000000000000002" }],
    // no linear — falls through to the default elsewhere; no members either
  },
};

describe("resolveCommunity", () => {
  const prev = config.communities;
  afterEach(() => {
    // Reassign (never mutate in place) so the reference-identity cache rebuilds.
    config.communities = prev;
  });

  test("each of a community's spaces resolves to the same community", () => {
    config.communities = COMMUNITIES;
    expect(resolveCommunity("discord", "1000000000000000001")?.id).toBe("dreamcatcher");
    expect(resolveCommunity("slack", "T000TEAMA0")?.id).toBe("dreamcatcher");
  });

  test("id is filled from the map key", () => {
    config.communities = COMMUNITIES;
    expect(resolveCommunity("discord", "1000000000000000002")).toMatchObject({ id: "other" });
  });

  test("a space in no community resolves to undefined", () => {
    config.communities = COMMUNITIES;
    expect(resolveCommunity("discord", "9999999999999999999")).toBeUndefined();
    // Right id, wrong surface — spaces are surface-scoped.
    expect(resolveCommunity("slack", "1000000000000000001")).toBeUndefined();
  });

  test("empty registry → every space is uncommunitied", () => {
    config.communities = {};
    expect(resolveCommunity("discord", "1000000000000000001")).toBeUndefined();
  });
});

describe("isCommunityMember", () => {
  const prev = config.communities;
  afterEach(() => {
    config.communities = prev;
  });

  test("a trusted member of a community is a member in each of its spaces (any surface)", () => {
    config.communities = COMMUNITIES;
    expect(isCommunityMember("member-a", "discord", "1000000000000000001")).toBe(true);
    expect(isCommunityMember("member-a", "slack", "T000TEAMA0")).toBe(true);
  });

  test("trusted:false / unlisted principals are not members", () => {
    config.communities = COMMUNITIES;
    expect(isCommunityMember("member-b", "discord", "1000000000000000001")).toBe(false);
    expect(isCommunityMember("stranger", "discord", "1000000000000000001")).toBe(false);
  });

  test("a member of one community is not a member of another community's space", () => {
    config.communities = COMMUNITIES;
    // member-a is trusted in dreamcatcher, but "other" has no members.
    expect(isCommunityMember("member-a", "discord", "1000000000000000002")).toBe(false);
  });

  test("a space in no community has no members", () => {
    config.communities = COMMUNITIES;
    expect(isCommunityMember("member-a", "discord", "9999999999999999999")).toBe(false);
  });
});

describe("buildCommunityIndex", () => {
  test("throws when two communities claim the same space", () => {
    expect(() =>
      buildCommunityIndex({
        a: { spaces: [{ surface: "discord", spaceId: "1000000000000000003" }] },
        b: { spaces: [{ surface: "discord", spaceId: "1000000000000000003" }] },
      }),
    ).toThrow(/claimed by both/);
  });
});
