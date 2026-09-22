import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import type { CommunityConfig } from "../../orchestration/communities.ts";
import { linearFor, resolveLinearAccount } from "./linear.ts";

// Placeholder credentials only — never a real API key or team id in a public repo.
const DEFAULT_KEY = "sushi-default-key";
const DEFAULT_TEAM = "SUSHI";

const COMMUNITIES: Record<string, CommunityConfig> = {
  dreamcatcher: {
    spaces: [{ surface: "discord", spaceId: "1000000000000000001" }],
    linear: { apiKey: "dreamcatcher-key", teamId: "DREAM" },
  },
  teamx: {
    spaces: [{ surface: "slack", spaceId: "T000TEAMX0" }],
    linear: { apiKey: "teamx-key", teamId: "TEAMX" },
  },
  // A community with NO linear must fall through to the default, never throw.
  nolinear: {
    spaces: [{ surface: "discord", spaceId: "1000000000000000009" }],
  },
};

describe("resolveLinearAccount", () => {
  const prevC = config.communities;
  const prevKey = config.linearApiKey;
  const prevTeam = config.linearTeamId;
  beforeEach(() => {
    config.communities = COMMUNITIES;
    config.linearApiKey = DEFAULT_KEY;
    config.linearTeamId = DEFAULT_TEAM;
  });
  afterEach(() => {
    config.communities = prevC;
    config.linearApiKey = prevKey;
    config.linearTeamId = prevTeam;
  });

  test("a community with its own Linear resolves to that account", () => {
    expect(resolveLinearAccount("discord", "1000000000000000001")).toEqual({ apiKey: "dreamcatcher-key", teamId: "DREAM" });
  });

  test("a space in no community falls through to the SUSHI default", () => {
    expect(resolveLinearAccount("discord", "9999999999999999999")).toEqual({ apiKey: DEFAULT_KEY, teamId: DEFAULT_TEAM });
  });

  test("a community WITHOUT linear falls through to the default (never throws)", () => {
    expect(resolveLinearAccount("discord", "1000000000000000009")).toEqual({ apiKey: DEFAULT_KEY, teamId: DEFAULT_TEAM });
  });

  test("both community and default unconfigured → empty account (linearFor decides the throw)", () => {
    config.communities = {};
    config.linearApiKey = undefined;
    config.linearTeamId = undefined;
    expect(resolveLinearAccount("discord", "any")).toEqual({ apiKey: "", teamId: "" });
  });
});

describe("linearFor — per-account caching", () => {
  const prevC = config.communities;
  const prevKey = config.linearApiKey;
  const prevTeam = config.linearTeamId;
  beforeEach(() => {
    config.communities = COMMUNITIES;
    config.linearApiKey = DEFAULT_KEY;
    config.linearTeamId = DEFAULT_TEAM;
  });
  afterEach(() => {
    config.communities = prevC;
    config.linearApiKey = prevKey;
    config.linearTeamId = prevTeam;
  });

  test("two communities get distinct clients (no cross-account contamination)", () => {
    const dc = linearFor("discord", "1000000000000000001");
    const tx = linearFor("slack", "T000TEAMX0");
    expect(dc).not.toBe(tx);
  });

  test("repeated calls for the same account return the cached instance", () => {
    expect(linearFor("discord", "1000000000000000001")).toBe(linearFor("discord", "1000000000000000001"));
  });

  test("a community without linear and a no-community space share the default instance", () => {
    const viaNoLinear = linearFor("discord", "1000000000000000009");
    const viaNoCommunity = linearFor("discord", "9999999999999999999");
    expect(viaNoLinear).toBe(viaNoCommunity);
  });

  test("throws only when neither community nor default has a key", () => {
    config.communities = {};
    config.linearApiKey = undefined;
    config.linearTeamId = undefined;
    expect(() => linearFor("discord", "any")).toThrow(/LINEAR_API_KEY is not configured/);
  });
});
