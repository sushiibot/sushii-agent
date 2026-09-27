import { describe, expect, mock, test } from "bun:test";
import { resolveOwnerPrincipals, resolveTeamsConfig, teamGuildConfigs } from "./config.ts";
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
    expect(resolveTeamsConfig(undefined, readFile)).toEqual({
      a: { spaces: [], wiki: undefined, linear: undefined, members: undefined, trustSpaceMembers: undefined },
    });
  });

  test("loads teams.json from an explicit TEAMS_PATH", () => {
    const readFile = fakeReadFile({ "/custom/teams.json": JSON.stringify({ a: { spaces: [] } }) });
    expect(resolveTeamsConfig("/custom/teams.json", readFile)).toEqual({
      a: { spaces: [], wiki: undefined, linear: undefined, members: undefined, trustSpaceMembers: undefined },
    });
  });

  test("an explicit TEAMS_PATH that can't be read throws", () => {
    const readFile = fakeReadFile({});
    expect(() => resolveTeamsConfig("/custom/teams.json", readFile)).toThrow(/Failed to load teams from \/custom\/teams\.json/);
  });

  test("TEAMS_PATH unset + default teams.json missing → empty, no error", () => {
    const readFile = fakeReadFile({});
    expect(resolveTeamsConfig(undefined, readFile)).toEqual({});
  });

  test("TEAMS_PATH unset + default teams.json present but invalid JSON still throws (not swallowed as 'no teams')", () => {
    const readFile = fakeReadFile({ "./teams.json": "not json" });
    expect(() => resolveTeamsConfig(undefined, readFile)).toThrow(/Invalid teams JSON in \.\/teams\.json/);
  });

  test("TEAMS_PATH unset + default teams.json present but shape-invalid still throws", () => {
    const readFile = fakeReadFile({ "./teams.json": JSON.stringify({ a: { spaces: "not an array" } }) });
    expect(() => resolveTeamsConfig(undefined, readFile)).toThrow(/teams: "a"\.spaces must be an array/);
  });
});

describe("teamGuildConfigs", () => {
  test("derives a guild config from a discord block, folding the space's statusChannelId into wiki", () => {
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
      "1000000000000000001": { allowedRoles: ["r1"], promptTemplate: "general", wiki: { statusChannelId: "s1" } },
    });
  });

  test("a space with no discord block contributes nothing, even with a statusChannelId", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: { spaces: [{ surface: "discord", spaceId: "1000000000000000001", statusChannelId: "s1" }] },
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
