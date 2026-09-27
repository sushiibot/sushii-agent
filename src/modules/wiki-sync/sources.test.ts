import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { config } from "../../config.ts";
import rootLogger from "../../logger.ts";
import type { GuildConfig } from "../../guildConfig.ts";
import { getWikiSources, resolveWikiIdForGuild, wikiFor, __resetWikiWarnDedup } from "./sources.ts";

const savedGuildConfig = config.guildConfig;
const savedSources = config.wikiSync.sources;
const savedTeams = config.teams;
const savedBuzzWikiMap = config.buzz.wikiMap;

function wikiGuild(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { allowedRoles: [], enabledModules: ["wiki-sync"], ...overrides };
}

afterEach(() => {
  config.guildConfig = savedGuildConfig;
  config.wikiSync.sources = savedSources;
  config.teams = savedTeams;
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
    config.teams = {
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
    config.teams = {
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
    config.teams = {
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
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source", statusChannelId: "team" }],
        wiki: { wikiId: "wiki1" },
      },
    };

    const map = getWikiSources();
    expect(map.get("wiki1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: "team" }]);
  });

  test("a team source space without its own statusChannelId falls back to guild-config's", () => {
    config.guildConfig = { g1: wikiGuild({ wiki: { statusChannelId: "guild-config" } }) };
    config.wikiSync.sources = {};
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "wiki1" },
      },
    };

    expect(getWikiSources().get("wiki1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: "guild-config" }]);
  });

  test("a team READ space that disagrees with a conflicting explicit entry still warns once, even though it isn't itself swept", () => {
    config.guildConfig = {};
    config.wikiSync.sources = { "legacy-wiki": { sources: [{ surface: "slack", spaceId: "T1" }] } };
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "slack", spaceId: "T1", wiki: "read" }],
        wiki: { wikiId: "team-wiki" },
      },
    };

    const warnSpy = spyOn(rootLogger, "warn");
    try {
      const map = getWikiSources();
      // The read space isn't a sweep source itself, so the legacy entry is still swept into its
      // own wikiId — but the disagreement is still surfaced from this code path.
      expect(map.get("legacy-wiki")).toEqual([{ surface: "slack", spaceId: "T1", statusChannelId: undefined }]);
      expect(map.has("team-wiki")).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a team SOURCE space that disagrees with a conflicting explicit entry warns once and keeps the team's wiki (no double ingest)", () => {
    config.guildConfig = {};
    config.wikiSync.sources = { "legacy-wiki": { sources: [{ surface: "discord", spaceId: "g1" }] } };
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "team-wiki" },
      },
    };

    const warnSpy = spyOn(rootLogger, "warn");
    try {
      const map = getWikiSources();
      expect(map.get("team-wiki")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: undefined }]);
      expect(map.has("legacy-wiki")).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not synthesize a wiki-sync-enabled guild's self-wiki when its own guild id is already used as a wikiId by an unrelated explicit entry", () => {
    // Explicit entry "g1" feeds g2, not g1 itself — g1 is wiki-sync enabled but not listed as a
    // source anywhere. A wikiId collision (entry key "g1" == guild id "g1") must still suppress
    // g1's self-wiki synthesis, matching the pre-team-resolver behavior.
    config.guildConfig = { g1: wikiGuild(), g2: wikiGuild() };
    config.wikiSync.sources = { g1: { sources: [{ surface: "discord", spaceId: "g2" }] } };

    const map = getWikiSources();
    expect(map.get("g1")).toEqual([{ surface: "discord", spaceId: "g2", statusChannelId: undefined }]);
  });
});

describe("wikiFor", () => {
  test("team source space feeds and reads the team's wiki", () => {
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "wiki1" },
      },
    };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "wiki1", feeds: true, reads: true });
  });

  test("team read space reads but does not feed", () => {
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "slack", spaceId: "T1", wiki: "read" }],
        wiki: { wikiId: "wiki1" },
      },
    };
    expect(wikiFor("slack", "T1")).toEqual({ wikiId: "wiki1", feeds: false, reads: true });
  });

  test("a team space with no wiki role has no wiki, even when the team has one", () => {
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1" }],
        wiki: { wikiId: "wiki1" },
      },
    };
    expect(wikiFor("discord", "g1")).toBeUndefined();
  });

  test("falls back to an explicit WIKI_SYNC_SOURCES entry when the team has no wiki fields", () => {
    config.teams = {};
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = { shared: { sources: [{ surface: "discord", spaceId: "g1" }] } };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "shared", feeds: true, reads: true });
  });

  test("falls back to BUZZ_WIKI_MAP (read-only) for a buzz relay", () => {
    config.teams = {};
    config.buzz.wikiMap = { "relay.example": "g1" };
    expect(wikiFor("buzz", "buzz:relay.example")).toEqual({ wikiId: "g1", feeds: false, reads: true });
  });

  test("BUZZ_WIKI_MAP keys the bare 'buzz' spaceId as 'default'", () => {
    config.teams = {};
    config.buzz.wikiMap = { default: "g1" };
    expect(wikiFor("buzz", "buzz")).toEqual({ wikiId: "g1", feeds: false, reads: true });
  });

  test("falls back to a Discord guild's own wiki-sync-enabled self-wiki", () => {
    config.teams = {};
    config.guildConfig = { g1: wikiGuild() };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "g1", feeds: true, reads: true });
  });

  test("a space with neither a team wiki nor a legacy mapping has none", () => {
    config.teams = {};
    config.guildConfig = {};
    config.wikiSync.sources = {};
    config.buzz.wikiMap = {};
    expect(wikiFor("discord", "unknown")).toBeUndefined();
  });

  test("team wins over a disagreeing legacy mapping, and warns exactly once across repeated calls", () => {
    config.teams = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }],
        wiki: { wikiId: "team-wiki" },
      },
    };
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = { "legacy-wiki": { sources: [{ surface: "discord", spaceId: "g1" }] } };

    const warnSpy = spyOn(rootLogger, "warn");
    try {
      expect(wikiFor("discord", "g1")).toEqual({ wikiId: "team-wiki", feeds: true, reads: true });
      expect(wikiFor("discord", "g1")).toEqual({ wikiId: "team-wiki", feeds: true, reads: true });
      expect(wikiFor("discord", "g1")).toEqual({ wikiId: "team-wiki", feeds: true, reads: true });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("an explicit WIKI_SYNC_SOURCES entry for a Discord guild without wiki-sync enabled grants no fs host", () => {
    config.teams = {};
    config.guildConfig = { g1: { allowedRoles: [] } };
    config.wikiSync.sources = { shared: { sources: [{ surface: "discord", spaceId: "g1" }] } };

    expect(wikiFor("discord", "g1")).toBeUndefined();
  });

  test("an explicit WIKI_SYNC_SOURCES entry for a Discord guild WITH wiki-sync enabled still grants an fs host", () => {
    config.teams = {};
    config.guildConfig = { g1: wikiGuild() };
    config.wikiSync.sources = { shared: { sources: [{ surface: "discord", spaceId: "g1" }] } };

    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "shared", feeds: true, reads: true });
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
