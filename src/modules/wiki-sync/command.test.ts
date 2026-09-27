import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import { wikiSyncCommandGuildIds } from "./command.ts";

const savedTeams = config.teams;
const savedGuildConfig = config.guildConfig;

afterEach(() => {
  config.teams = savedTeams;
  config.guildConfig = savedGuildConfig;
});

describe("wikiSyncCommandGuildIds", () => {
  test("includes a guild whose team space feeds a wiki", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }] },
    };
    config.guildConfig = { g1: { allowedRoles: [] } };
    expect(wikiSyncCommandGuildIds()).toEqual(["g1"]);
  });

  test("excludes a guild whose team space only reads", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1", wiki: "read" }] },
    };
    config.guildConfig = { g1: { allowedRoles: [] } };
    expect(wikiSyncCommandGuildIds()).toEqual([]);
  });

  test("excludes a guild with no wiki role at all", () => {
    config.teams = { a: { spaces: [{ surface: "discord", spaceId: "g1" }] } };
    config.guildConfig = { g1: { allowedRoles: [] } };
    expect(wikiSyncCommandGuildIds()).toEqual([]);
  });

  test("no guilds configured → empty list", () => {
    config.teams = {};
    config.guildConfig = {};
    expect(wikiSyncCommandGuildIds()).toEqual([]);
  });
});
