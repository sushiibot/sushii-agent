import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import { getWikiSources, resolveWikiIdForGuild, wikiFor } from "./sources.ts";

const savedTeams = config.teams;

afterEach(() => {
  config.teams = savedTeams;
});

describe("wikiFor", () => {
  test("a team space with wiki: \"source\" feeds and reads", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }] },
    };
    expect(wikiFor("discord", "g1")).toEqual({ wikiId: "w1", feeds: true, reads: true });
  });

  test("a team space with wiki: \"read\" reads only", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "slack", spaceId: "T1", wiki: "read" }] },
    };
    expect(wikiFor("slack", "T1")).toEqual({ wikiId: "w1", feeds: false, reads: true });
  });

  test("a team space with no wiki role has no assignment even though its team has a wiki", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1" }] },
    };
    expect(wikiFor("discord", "g1")).toBeUndefined();
  });

  test("a team with no wiki.wikiId has no assignment even if a space sets a wiki role", () => {
    config.teams = {
      a: { spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }] },
    };
    expect(wikiFor("discord", "g1")).toBeUndefined();
  });

  test("a space in no team has no assignment", () => {
    config.teams = {};
    expect(wikiFor("discord", "g1")).toBeUndefined();
  });
});

describe("getWikiSources", () => {
  test("every team space with wiki: \"source\" feeds its team's wiki, with its own statusChannelId", () => {
    config.teams = {
      a: {
        wiki: { wikiId: "w1" },
        spaces: [{ surface: "discord", spaceId: "g1", wiki: "source", statusChannelId: "s1" }],
      },
    };
    const map = getWikiSources();
    expect(map.get("w1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: "s1" }]);
  });

  test("a read-only space never feeds — it's absent from the sources map", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "slack", spaceId: "T1", wiki: "read" }] },
    };
    expect(getWikiSources().get("w1")).toBeUndefined();
  });

  test("two source spaces of one team's wiki both feed it — no double ingest, each keeps its own key", () => {
    config.teams = {
      a: {
        wiki: { wikiId: "w1" },
        spaces: [
          { surface: "discord", spaceId: "g1", wiki: "source" },
          { surface: "slack", spaceId: "T1", wiki: "source" },
        ],
      },
    };
    const sources = getWikiSources().get("w1") ?? [];
    expect(sources.map((s) => `${s.surface} ${s.spaceId}`).sort()).toEqual(["discord g1", "slack T1"]);
  });

  test("two teams' wikis produce two independent entries", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }] },
      b: { wiki: { wikiId: "w2" }, spaces: [{ surface: "discord", spaceId: "g2", wiki: "source" }] },
    };
    const map = getWikiSources();
    expect(map.get("w1")).toEqual([{ surface: "discord", spaceId: "g1", statusChannelId: undefined }]);
    expect(map.get("w2")).toEqual([{ surface: "discord", spaceId: "g2", statusChannelId: undefined }]);
  });

  test("no teams configured → empty map", () => {
    config.teams = {};
    expect(getWikiSources().size).toBe(0);
  });
});

describe("resolveWikiIdForGuild", () => {
  test("a guild whose team space feeds a wiki resolves to that wikiId", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1", wiki: "source" }] },
    };
    expect(resolveWikiIdForGuild("g1")).toBe("w1");
  });

  test("a guild whose team space only reads (never feeds) resolves to undefined", () => {
    config.teams = {
      a: { wiki: { wikiId: "w1" }, spaces: [{ surface: "discord", spaceId: "g1", wiki: "read" }] },
    };
    expect(resolveWikiIdForGuild("g1")).toBeUndefined();
  });

  test("a guild with no team, or no wiki role, resolves to undefined (no self-wiki synthesis)", () => {
    config.teams = {};
    expect(resolveWikiIdForGuild("g1")).toBeUndefined();
  });
});
