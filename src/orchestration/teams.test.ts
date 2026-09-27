import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { TeamConfig } from "./teams.ts";
import { buildTeamIndex, buzzAvatarFor, isTeamMember, parseTeams, resolveTeam } from "./teams.ts";

// Placeholder ids only — never real guild/team ids in a public repo.
const TEAMS: Record<string, TeamConfig> = {
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

describe("resolveTeam", () => {
  const prev = config.teams;
  afterEach(() => {
    // Reassign (never mutate in place) so the reference-identity cache rebuilds.
    config.teams = prev;
  });

  test("each of a team's spaces resolves to the same team", () => {
    config.teams = TEAMS;
    expect(resolveTeam("discord", "1000000000000000001")?.id).toBe("dreamcatcher");
    expect(resolveTeam("slack", "T000TEAMA0")?.id).toBe("dreamcatcher");
  });

  test("id is filled from the map key", () => {
    config.teams = TEAMS;
    expect(resolveTeam("discord", "1000000000000000002")).toMatchObject({ id: "other" });
  });

  test("a space in no team resolves to undefined", () => {
    config.teams = TEAMS;
    expect(resolveTeam("discord", "9999999999999999999")).toBeUndefined();
    // Right id, wrong surface — spaces are surface-scoped.
    expect(resolveTeam("slack", "1000000000000000001")).toBeUndefined();
  });

  test("empty registry → every space is teamless", () => {
    config.teams = {};
    expect(resolveTeam("discord", "1000000000000000001")).toBeUndefined();
  });
});

describe("isTeamMember", () => {
  const prev = config.teams;
  afterEach(() => {
    config.teams = prev;
  });

  test("a trusted member of a team is a member in each of its spaces (any surface)", () => {
    config.teams = TEAMS;
    expect(isTeamMember("member-a", "discord", "1000000000000000001")).toBe(true);
    expect(isTeamMember("member-a", "slack", "T000TEAMA0")).toBe(true);
  });

  test("trusted:false / unlisted principals are not members", () => {
    config.teams = TEAMS;
    expect(isTeamMember("member-b", "discord", "1000000000000000001")).toBe(false);
    expect(isTeamMember("stranger", "discord", "1000000000000000001")).toBe(false);
  });

  test("a member of one team is not a member of another team's space", () => {
    config.teams = TEAMS;
    // member-a is trusted in dreamcatcher, but "other" has no members.
    expect(isTeamMember("member-a", "discord", "1000000000000000002")).toBe(false);
  });

  test("a space in no team has no members", () => {
    config.teams = TEAMS;
    expect(isTeamMember("member-a", "discord", "9999999999999999999")).toBe(false);
  });
});

describe("parseTeams: space wiki fields", () => {
  test("accepts 'source' and 'read', with an optional statusChannelId", () => {
    const out = parseTeams({
      a: {
        spaces: [
          { surface: "discord", spaceId: "g1", wiki: "source", statusChannelId: "s1" },
          { surface: "slack", spaceId: "T1", wiki: "read" },
        ],
        wiki: { wikiId: "g1" },
      },
    });
    expect(out["a"]?.spaces[0]).toEqual({ surface: "discord", spaceId: "g1", wiki: "source", statusChannelId: "s1" });
    expect(out["a"]?.spaces[1]).toEqual({ surface: "slack", spaceId: "T1", wiki: "read", statusChannelId: undefined });
  });

  test("a space with no wiki field parses with wiki undefined", () => {
    const out = parseTeams({ a: { spaces: [{ surface: "discord", spaceId: "g1" }] } });
    expect(out["a"]?.spaces[0]?.wiki).toBeUndefined();
  });

  test("rejects a wiki value other than 'source' or 'read'", () => {
    expect(() =>
      parseTeams({ a: { spaces: [{ surface: "discord", spaceId: "g1", wiki: "both" }] } }),
    ).toThrow(/\.wiki must be "source" or "read"/);
  });

  test("rejects a non-string statusChannelId", () => {
    expect(() =>
      parseTeams({ a: { spaces: [{ surface: "discord", spaceId: "g1", statusChannelId: 123 }] } }),
    ).toThrow(/statusChannelId must be a string/);
  });
});

describe("parseTeams: linear shape", () => {
  test("accepts {teamId, apiKeyEnv}", () => {
    const out = parseTeams({ a: { spaces: [], linear: { teamId: "ENG", apiKeyEnv: "ENG_LINEAR_API_KEY" } } });
    expect(out["a"]?.linear).toEqual({ teamId: "ENG", apiKeyEnv: "ENG_LINEAR_API_KEY", apiKey: undefined });
  });

  test("accepts a legacy literal {teamId, apiKey}", () => {
    const out = parseTeams({ a: { spaces: [], linear: { teamId: "ENG", apiKey: "literal-key" } } });
    expect(out["a"]?.linear).toEqual({ teamId: "ENG", apiKeyEnv: undefined, apiKey: "literal-key" });
  });

  test("rejects linear missing teamId", () => {
    expect(() => parseTeams({ a: { spaces: [], linear: { apiKeyEnv: "X" } } })).toThrow(/\.linear must be/);
  });

  test("rejects a non-string apiKeyEnv", () => {
    expect(() => parseTeams({ a: { spaces: [], linear: { teamId: "ENG", apiKeyEnv: 123 } } })).toThrow(/apiKeyEnv must be a string/);
  });
});

describe("parseTeams: inline discord block", () => {
  test("accepts a full discord block on a discord surface space", () => {
    const out = parseTeams({
      a: {
        spaces: [
          {
            surface: "discord",
            spaceId: "g1",
            statusChannelId: "s1",
            discord: { allowedRoles: ["r1"], emojis: ["<:x:1>"], promptTemplate: "general", enabledModules: ["moderation"] },
          },
        ],
      },
    });
    expect(out["a"]?.spaces[0]?.discord).toEqual({
      allowedRoles: ["r1"],
      emojis: ["<:x:1>"],
      modRoleId: undefined,
      alertsChannelId: undefined,
      modImmuneRoleIds: undefined,
      newMemberThresholdDays: undefined,
      autoModDryRun: undefined,
      autoModTriggerRoleIds: undefined,
      autoModCooldownSeconds: undefined,
      mcpBridgeAllowedUserIds: undefined,
      promptTemplate: "general",
      enabledModules: ["moderation"],
    });
  });

  test("rejects a discord block on a non-discord surface space", () => {
    expect(() =>
      parseTeams({ a: { spaces: [{ surface: "buzz", spaceId: "buzz:https://r", discord: { allowedRoles: [] } }] } }),
    ).toThrow(/discord is only allowed on a "discord" surface space/);
  });

  test("requires allowedRoles", () => {
    expect(() => parseTeams({ a: { spaces: [{ surface: "discord", spaceId: "g1", discord: {} }] } })).toThrow(
      /allowedRoles must be a string array/,
    );
  });

  test("rejects discord.wiki.statusChannelId, pointing to the space-level field instead", () => {
    expect(() =>
      parseTeams({
        a: {
          spaces: [{ surface: "discord", spaceId: "g1", discord: { allowedRoles: [], wiki: { statusChannelId: "s1" } } }],
        },
      }),
    ).toThrow(/wiki\.statusChannelId is not allowed — use the space-level statusChannelId field instead/);
  });

  test("rejects an invalid enabledModules entry", () => {
    expect(() =>
      parseTeams({ a: { spaces: [{ surface: "discord", spaceId: "g1", discord: { allowedRoles: [], enabledModules: ["bogus"] } }] } }),
    ).toThrow(/enabledModules must be an array/);
  });
});

describe("parseTeams: inline buzz block", () => {
  test("accepts an avatarUrl on a buzz surface space", () => {
    const out = parseTeams({
      a: { spaces: [{ surface: "buzz", spaceId: "buzz:https://relay.example", buzz: { avatarUrl: "https://img" } }] },
    });
    expect(out["a"]?.spaces[0]?.buzz).toEqual({ avatarUrl: "https://img" });
  });

  test("rejects a buzz block on a non-buzz surface space", () => {
    expect(() =>
      parseTeams({ a: { spaces: [{ surface: "discord", spaceId: "g1", buzz: { avatarUrl: "https://img" } }] } }),
    ).toThrow(/buzz is only allowed on a "buzz" surface space/);
  });
});

describe("buzzAvatarFor", () => {
  const prev = config.teams;
  const prevAvatarMap = config.buzz.avatarMap;
  const prevAvatarUrl = config.buzz.avatarUrl;
  afterEach(() => {
    config.teams = prev;
    config.buzz.avatarMap = prevAvatarMap;
    config.buzz.avatarUrl = prevAvatarUrl;
  });

  test("a team space's inline avatarUrl wins over the env avatar map and fallback", () => {
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "buzz", spaceId: "buzz:https://relay.example", buzz: { avatarUrl: "https://team-avatar" } }],
      },
    };
    config.buzz.avatarMap = { "https://relay.example": "https://env-avatar" };
    config.buzz.avatarUrl = "https://fallback-avatar";
    expect(buzzAvatarFor("buzz:https://relay.example")).toBe("https://team-avatar");
  });

  test("falls back to BUZZ_AVATAR_MAP when no team avatar is set", () => {
    config.teams = {};
    config.buzz.avatarMap = { "https://relay.example": "https://env-avatar" };
    config.buzz.avatarUrl = "https://fallback-avatar";
    expect(buzzAvatarFor("buzz:https://relay.example")).toBe("https://env-avatar");
  });

  test("falls back to BUZZ_AVATAR_URL when neither a team avatar nor a map entry exists", () => {
    config.teams = {};
    config.buzz.avatarMap = {};
    config.buzz.avatarUrl = "https://fallback-avatar";
    expect(buzzAvatarFor("buzz:https://relay.example")).toBe("https://fallback-avatar");
  });
});

describe("buildTeamIndex", () => {
  test("throws when two teams claim the same space", () => {
    expect(() =>
      buildTeamIndex({
        a: { spaces: [{ surface: "discord", spaceId: "1000000000000000003" }] },
        b: { spaces: [{ surface: "discord", spaceId: "1000000000000000003" }] },
      }),
    ).toThrow(/claimed by both/);
  });
});
