import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import type { GuildConfig } from "../../guildConfig.ts";
import { getWikiSources, resolveWikiIdForGuild } from "./sources.ts";

const savedGuildConfig = config.guildConfig;
const savedSources = config.wikiSync.sources;

function wikiGuild(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { allowedRoles: [], enabledModules: ["wiki-sync"], ...overrides };
}

afterEach(() => {
  config.guildConfig = savedGuildConfig;
  config.wikiSync.sources = savedSources;
});

describe("getWikiSources", () => {
  test("synthesizes an enabled Discord guild as its own single-source wiki (wikiId === guildId)", () => {
    config.guildConfig = { g1: wikiGuild({ wiki: { statusChannelId: "s1" } }) };
    config.wikiSync.sources = {};

    const map = getWikiSources();
    expect(map.get("g1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: "s1" }]);
  });

  test("does not synthesize a guild already claimed as a discord source by an explicit entry", () => {
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = {
      shared: { sources: [{ surface: "discord", spaceId: "g1" }, { surface: "slack", spaceId: "T1" }] },
    };

    const map = getWikiSources();
    // g1 flows into the "shared" wiki, not a separate "g1" wiki — no double ingest.
    expect(map.has("g1")).toBe(false);
    expect(map.get("shared")).toEqual([
      { surface: "discord", spaceId: "g1", statusChannelId: undefined },
      { surface: "slack", spaceId: "T1", statusChannelId: undefined },
    ]);
  });

  test("ignores guilds that don't have wiki-sync enabled", () => {
    config.guildConfig = { g1: wikiGuild(), g2: { allowedRoles: [] } };
    config.wikiSync.sources = {};

    const map = getWikiSources();
    expect(map.has("g1")).toBe(true);
    expect(map.has("g2")).toBe(false);
  });
});

describe("resolveWikiIdForGuild", () => {
  test("defaults to the guild's own synthesized wiki", () => {
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = {};
    expect(resolveWikiIdForGuild("g1")).toBe("g1");
  });

  test("resolves to the shared wiki a guild feeds via an explicit entry", () => {
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = { shared: { sources: [{ surface: "discord", spaceId: "g1" }] } };
    expect(resolveWikiIdForGuild("g1")).toBe("shared");
  });

  test("falls back to the guild id when nothing maps it", () => {
    config.guildConfig = {};
    config.wikiSync.sources = {};
    expect(resolveWikiIdForGuild("unknown")).toBe("unknown");
  });
});
