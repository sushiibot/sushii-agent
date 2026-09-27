import { describe, expect, mock, test } from "bun:test";
import { resolveOwnerPrincipals, resolveTeamsConfig } from "./config.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";

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
});
