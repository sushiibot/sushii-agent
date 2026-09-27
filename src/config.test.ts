import { describe, expect, mock, test } from "bun:test";
import {
  applyStatusChannelOverrides,
  mergeGuildConfigs,
  resolveOwnerPrincipals,
  resolveTeamsConfig,
  teamGuildConfigs,
  teamStatusChannelIds,
} from "./config.ts";
import type { GuildConfig } from "./guildConfig.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";
import type { TeamConfig } from "./orchestration/teams.ts";

function fakeReadFile(files: Record<string, string>): (filePath: string) => string {
  return (filePath) => {
    const content = files[filePath];
    if (content === undefined) throw new Error(`ENOENT: no such file, open '${filePath}'`);
    return content;
  };
}

describe("resolveOwnerPrincipals", () => {
  test("missing/empty registry + OWNER_DISCORD_ID set synthesizes a single owner principal", () => {
    const warn = mock();
    expect(resolveOwnerPrincipals({}, "100000000000000000", warn)).toEqual({
      owner: { owner: true, identities: { discord: "100000000000000000" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("neither set stays empty — nobody is owner, no warning", () => {
    const warn = mock();
    expect(resolveOwnerPrincipals({}, undefined, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("a non-empty registry is used as-is, never merged with OWNER_DISCORD_ID", () => {
    const raw: Record<string, PrincipalConfig> = {
      drk: { owner: true, identities: { discord: "100000000000000000", slack: "U1" } },
      alice: { identities: { discord: "200000000000000000" } },
    };
    expect(resolveOwnerPrincipals(raw, "999999999999999999")).toBe(raw);
  });

  test("a registry with members but no declared owner is used as-is, not synthesized over, no warning", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { alice: { identities: { discord: "200000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000", warn)).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a matching file owner + OWNER_DISCORD_ID logs no warning and returns the file as-is", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000", warn)).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a mismatched file owner + OWNER_DISCORD_ID warns once and still returns the file as-is (file wins)", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "999999999999999999", warn)).toBe(raw);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({
      principalId: "drk",
      fileOwnerDiscord: "100000000000000000",
      ownerDiscordId: "999999999999999999",
    });
  });
});

describe("resolveTeamsConfig", () => {
  test("loads teams.json from the default path when TEAMS_PATH is unset", () => {
    const readFile = fakeReadFile({ "./teams.json": JSON.stringify({ a: { spaces: [] } }) });
    const warn = mock();
    expect(resolveTeamsConfig(undefined, undefined, readFile, warn)).toEqual({ a: { spaces: [], wiki: undefined, linear: undefined, members: undefined } });
    expect(warn).not.toHaveBeenCalled();
  });

  test("loads teams.json from an explicit TEAMS_PATH", () => {
    const readFile = fakeReadFile({ "/custom/teams.json": JSON.stringify({ a: { spaces: [] } }) });
    const warn = mock();
    expect(resolveTeamsConfig("/custom/teams.json", undefined, readFile, warn)).toEqual({
      a: { spaces: [], wiki: undefined, linear: undefined, members: undefined },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("an explicit TEAMS_PATH that can't be read throws", () => {
    const readFile = fakeReadFile({});
    expect(() => resolveTeamsConfig("/custom/teams.json", undefined, readFile)).toThrow(/Failed to load teams from \/custom\/teams\.json/);
  });

  test("TEAMS_PATH unset + default teams.json missing falls back to the default communities.json, warning once", () => {
    const readFile = fakeReadFile({ "./communities.json": JSON.stringify({ a: { spaces: [] } }) });
    const warn = mock();
    expect(resolveTeamsConfig(undefined, undefined, readFile, warn)).toEqual({ a: { spaces: [], wiki: undefined, linear: undefined, members: undefined } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ filePath: "./communities.json" });
  });

  test("TEAMS_PATH unset + default teams.json missing falls back to an explicit COMMUNITIES_PATH, warning once", () => {
    const readFile = fakeReadFile({ "/legacy/communities.json": JSON.stringify({ a: { spaces: [] } }) });
    const warn = mock();
    expect(resolveTeamsConfig(undefined, "/legacy/communities.json", readFile, warn)).toEqual({
      a: { spaces: [], wiki: undefined, linear: undefined, members: undefined },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("both TEAMS_PATH and COMMUNITIES_PATH set explicitly throws, before touching either file", () => {
    const readFile = fakeReadFile({});
    expect(() => resolveTeamsConfig("/a/teams.json", "/b/communities.json", readFile)).toThrow(
      /Set only one of TEAMS_PATH or COMMUNITIES_PATH/,
    );
  });

  test("neither path readable and neither set explicitly → empty, no warning", () => {
    const readFile = fakeReadFile({});
    const warn = mock();
    expect(resolveTeamsConfig(undefined, undefined, readFile, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("an explicit COMMUNITIES_PATH (TEAMS_PATH unset, default teams.json missing) that can't be read throws", () => {
    const readFile = fakeReadFile({});
    expect(() => resolveTeamsConfig(undefined, "/legacy/communities.json", readFile)).toThrow(
      /Failed to load teams from \/legacy\/communities\.json/,
    );
  });

  test("an explicit COMMUNITIES_PATH is never shadowed by a present default ./teams.json", () => {
    const readFile = fakeReadFile({
      "./teams.json": JSON.stringify({ stub: { spaces: [] } }),
      "/prod/communities.json": JSON.stringify({ dreamcatcher: { spaces: [] } }),
    });
    const warn = mock();
    expect(resolveTeamsConfig(undefined, "/prod/communities.json", readFile, warn)).toEqual({
      dreamcatcher: { spaces: [], wiki: undefined, linear: undefined, members: undefined },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ filePath: "/prod/communities.json" });
  });
});

describe("teamGuildConfigs", () => {
  test("derives a guild config from a discord block, without folding statusChannelId into wiki", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: {
        spaces: [
          {
            surface: "discord",
            spaceId: "1000000000000000001",
            statusChannelId: "s1",
            discord: { allowedRoles: ["r1"], promptTemplate: "general" },
          },
        ],
      },
    };
    expect(teamGuildConfigs(teams)).toEqual({
      "1000000000000000001": { allowedRoles: ["r1"], promptTemplate: "general" },
    });
  });

  test("a space with no discord block contributes nothing", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: { spaces: [{ surface: "discord", spaceId: "1000000000000000001" }] },
    };
    expect(teamGuildConfigs(teams)).toEqual({});
  });

  test("a discord block with no space-level statusChannelId passes through untouched", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", discord: { allowedRoles: ["r1"] } }],
      },
    };
    expect(teamGuildConfigs(teams)).toEqual({ g1: { allowedRoles: ["r1"] } });
  });
});

describe("teamStatusChannelIds", () => {
  test("collects a discord space's statusChannelId regardless of whether it has a discord block", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: {
        spaces: [
          { surface: "discord", spaceId: "g1", statusChannelId: "s1" },
          { surface: "discord", spaceId: "g2", statusChannelId: "s2", discord: { allowedRoles: ["r1"] } },
          { surface: "discord", spaceId: "g3" },
          { surface: "buzz", spaceId: "buzz:https://relay.example", statusChannelId: "ignored" },
        ],
      },
    };
    expect(teamStatusChannelIds(teams)).toEqual({ g1: "s1", g2: "s2" });
  });
});

describe("mergeGuildConfigs", () => {
  test("a guild present only in the team config passes through", () => {
    const teamConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    expect(mergeGuildConfigs({}, teamConfig)).toEqual({ g1: { allowedRoles: ["r1"] } });
  });

  test("a guild present only in guild-config.json passes through, no warning", () => {
    const warn = mock();
    const fileConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    expect(mergeGuildConfigs(fileConfig, {}, warn)).toEqual({ g1: { allowedRoles: ["r1"] } });
    expect(warn).not.toHaveBeenCalled();
  });

  test("a guild in both, with conflicting fields, throws naming the guild and field", () => {
    const fileConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    const teamConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r2"] } };
    expect(() => mergeGuildConfigs(fileConfig, teamConfig)).toThrow(/g1.*allowedRoles/s);
  });

  test("a guild in both, with non-conflicting fields, merges and warns once", () => {
    const warn = mock();
    const fileConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    const teamConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"], promptTemplate: "general" } };
    expect(mergeGuildConfigs(fileConfig, teamConfig, warn)).toEqual({
      g1: { allowedRoles: ["r1"], promptTemplate: "general" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ guildId: "g1" });
  });

  test("a set-like array field listed in a different order is not a conflict", () => {
    const warn = mock();
    const fileConfig: Record<string, GuildConfig> = {
      "1534944815223935177": { allowedRoles: ["1536111596072603811", "1536111892760625152"] },
    };
    const teamConfig: Record<string, GuildConfig> = {
      "1534944815223935177": { allowedRoles: ["1536111892760625152", "1536111596072603811"] },
    };
    expect(mergeGuildConfigs(fileConfig, teamConfig, warn)).toEqual({
      "1534944815223935177": { allowedRoles: ["1536111596072603811", "1536111892760625152"] },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a set-like array field with a genuinely different member set still throws", () => {
    const fileConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1", "r2"] } };
    const teamConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1", "r3"] } };
    expect(() => mergeGuildConfigs(fileConfig, teamConfig)).toThrow(/g1.*allowedRoles/s);
  });
});

describe("applyStatusChannelOverrides", () => {
  test("no-op when there are no statusChannelIds to apply", () => {
    const merged: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    expect(applyStatusChannelOverrides(merged, {})).toEqual(merged);
  });

  test("overrides wiki.statusChannelId on an existing guild-config.json-only entry (no discord block)", () => {
    const merged: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    expect(applyStatusChannelOverrides(merged, { g1: "team-channel" })).toEqual({
      g1: { allowedRoles: ["r1"], wiki: { statusChannelId: "team-channel" } },
    });
  });

  test("never synthesizes a bare entry for a guild with no existing config", () => {
    expect(applyStatusChannelOverrides({}, { g1: "team-channel" })).toEqual({});
  });

  test("wins over a conflicting guild-config.json wiki.statusChannelId and warns once, without throwing", () => {
    const warn = mock();
    const merged: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"], wiki: { statusChannelId: "old" } } };
    expect(applyStatusChannelOverrides(merged, { g1: "team-channel" }, warn)).toEqual({
      g1: { allowedRoles: ["r1"], wiki: { statusChannelId: "team-channel" } },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({
      guildId: "g1",
      fileStatusChannelId: "old",
      teamStatusChannelId: "team-channel",
    });
  });

  test("matching guild-config.json wiki.statusChannelId is a no-op with no warning", () => {
    const warn = mock();
    const merged: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"], wiki: { statusChannelId: "same" } } };
    expect(applyStatusChannelOverrides(merged, { g1: "same" }, warn)).toEqual({
      g1: { allowedRoles: ["r1"], wiki: { statusChannelId: "same" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("end-to-end: a discord-block-less team space's statusChannelId reaches the merged guildConfig", () => {
    const fileConfig: Record<string, GuildConfig> = { g1: { allowedRoles: ["r1"] } };
    const merged = mergeGuildConfigs(fileConfig, teamGuildConfigs({}));
    const out = applyStatusChannelOverrides(merged, { g1: "team-channel" });
    expect(out).toEqual({ g1: { allowedRoles: ["r1"], wiki: { statusChannelId: "team-channel" } } });
  });
});
