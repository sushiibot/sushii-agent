import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { config } from "../../config.ts";
import rootLogger from "../../logger.ts";
import type { GuildConfig } from "../../guildConfig.ts";
import { getWikiSources, resolveWikiIdForGuild, wikiFor, __resetWikiWarnDedup } from "./sources.ts";

const savedGuildConfig = config.guildConfig;
const savedSources = config.wikiSync.sources;
const savedCommunities = config.communities;
const savedBuzzWikiMap = config.buzz.wikiMap;

function wikiGuild(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { allowedRoles: [], enabledModules: ["wiki-sync"], ...overrides };
}

afterEach(() => {
  config.guildConfig = savedGuildConfig;
  config.wikiSync.sources = savedSources;
  config.communities = savedCommunities;
  config.buzz.wikiMap = savedBuzzWikiMap;
  __resetWikiWarnDedup();
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

  test("an explicit discord source without statusChannelId inherits guild-config's", () => {
    config.guildConfig = { g1: wikiGuild({ wiki: { statusChannelId: "s1" } }) };
    config.wikiSync.sources = {
      shared: { sources: [{ surface: "discord", spaceId: "g1" }, { surface: "slack", spaceId: "T1" }] },
    };

    const map = getWikiSources();
    expect(map.get("shared")).toEqual([
      { surface: "discord", spaceId: "g1", statusChannelId: "s1" },
      { surface: "slack", spaceId: "T1", statusChannelId: undefined },
    ]);
  });

  test("an explicit statusChannelId still wins over guild-config's", () => {
    config.guildConfig = { g1: wikiGuild({ wiki: { statusChannelId: "s1" } }) };
    config.wikiSync.sources = {
      shared: { sources: [{ surface: "discord", spaceId: "g1", statusChannelId: "explicit" }] },
    };

    const map = getWikiSources();
    expect(map.get("shared")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: "explicit" }]);
  });

  test("ignores guilds that don't have wiki-sync enabled", () => {
    config.guildConfig = { g1: wikiGuild(), g2: { allowedRoles: [] } };
    config.wikiSync.sources = {};

    const map = getWikiSources();
    expect(map.has("g1")).toBe(true);
    expect(map.has("g2")).toBe(false);
  });

  test("includes a team's source spaces, with the space's own statusChannelId", () => {
    config.guildConfig = {};
    config.wikiSync.sources = {};
    config.communities = {
      dreamcatcher: {
        spaces: [
          { surface: "discord", spaceId: "g1", wiki: "source", statusChannelId: "s1" },
          { surface: "slack", spaceId: "T1", wiki: "source" },
        ],
        wiki: { wikiId: "wiki1" },
      },
    };

    const map = getWikiSources();
    expect(map.get("wiki1")).toEqual([
      { surface: "discord", spaceId: "g1", statusChannelId: "s1" },
      { surface: "slack", spaceId: "T1", statusChannelId: undefined },
    ]);
  });

  test("a team source space is not also synthesized as its own single-source wiki", () => {
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = {};
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "wiki1" },
      },
    };

    const map = getWikiSources();
    expect(map.has("g1")).toBe(false);
    expect(map.get("wiki1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: undefined }]);
  });

  test("a team source space is not also double-ingested via an explicit WIKI_SYNC_SOURCES entry", () => {
    config.guildConfig = {};
    config.wikiSync.sources = { shared: { sources: [{ surface: "discord", spaceId: "g1" }] } };
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "wiki1" },
      },
    };

    const map = getWikiSources();
    expect(map.has("shared")).toBe(false);
    expect(map.get("wiki1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: undefined }]);
  });

  test("a team space's statusChannelId wins over an explicit entry's and guild-config's", () => {
    config.guildConfig = { g1: wikiGuild({ wiki: { statusChannelId: "guild-config" } }) };
    config.wikiSync.sources = {};
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source", statusChannelId: "team" }],
        wiki: { wikiId: "wiki1" },
      },
    };

    const map = getWikiSources();
    expect(map.get("wiki1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: "team" }]);
  });
});

describe("wikiFor", () => {
  test("team source space feeds and reads the team's wiki", () => {
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "wiki1" },
      },
    };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "wiki1", feeds: true, reads: true });
  });

  test("team read space reads but does not feed", () => {
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "slack", spaceId: "T1", wiki: "read" }],
        wiki: { wikiId: "wiki1" },
      },
    };
    expect(wikiFor("slack", "T1")).toEqual({ wikiId: "wiki1", feeds: false, reads: true });
  });

  test("a team space with no wiki role has no wiki, even when the community has one", () => {
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1" }],
        wiki: { wikiId: "wiki1" },
      },
    };
    expect(wikiFor("discord", "g1")).toBeUndefined();
  });

  test("falls back to an explicit WIKI_SYNC_SOURCES entry when the team has no wiki fields", () => {
    config.communities = {};
    config.wikiSync.sources = { shared: { sources: [{ surface: "discord", spaceId: "g1" }] } };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "shared", feeds: true, reads: true });
  });

  test("falls back to BUZZ_WIKI_MAP (read-only) for a buzz relay", () => {
    config.communities = {};
    config.buzz.wikiMap = { "relay.example": "g1" };
    expect(wikiFor("buzz", "buzz:relay.example")).toEqual({ wikiId: "g1", feeds: false, reads: true });
  });

  test("BUZZ_WIKI_MAP keys the bare 'buzz' spaceId as 'default'", () => {
    config.communities = {};
    config.buzz.wikiMap = { default: "g1" };
    expect(wikiFor("buzz", "buzz")).toEqual({ wikiId: "g1", feeds: false, reads: true });
  });

  test("falls back to a Discord guild's own wiki-sync-enabled self-wiki", () => {
    config.communities = {};
    config.guildConfig = { g1: wikiGuild() };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "g1", feeds: true, reads: true });
  });

  test("a space with neither a team wiki nor a legacy mapping has none", () => {
    config.communities = {};
    config.guildConfig = {};
    config.wikiSync.sources = {};
    config.buzz.wikiMap = {};
    expect(wikiFor("discord", "unknown")).toBeUndefined();
  });

  test("team wins over a disagreeing legacy mapping, and warns exactly once across repeated calls", () => {
    config.communities = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "team-wiki" },
      },
    };
    config.wikiSync.sources = { "legacy-wiki": { sources: [{ surface: "discord", spaceId: "g1" }] } };

    const warnSpy = spyOn(rootLogger, "warn");
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "team-wiki", feeds: true, reads: true });
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "team-wiki", feeds: true, reads: true });
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "team-wiki", feeds: true, reads: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
