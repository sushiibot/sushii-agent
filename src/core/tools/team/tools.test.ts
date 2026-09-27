import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "../../contracts.ts";
import { config } from "../../../config.ts";
import { buildCommunityIndex, parseCommunities, type CommunityConfig } from "../../../orchestration/communities.ts";
import type { PrincipalConfig } from "../../../orchestration/principals.ts";
import { resolveTeamConfig, type SpaceStats } from "../../../orchestration/teamConfig.ts";
import { teamConfigEntry } from "./tools.ts";

const SERVER_CONTEXT_BODY = "SERVER_CONTEXT_BODY";
const memoryCounts: Record<string, { entries: number; context: string | null }> = {
  G1: { entries: 3, context: SERVER_CONTEXT_BODY },
};

const stats: SpaceStats = (spaceId) => ({
  memoryEntries: memoryCounts[spaceId]?.entries ?? 0,
  contextChars: memoryCounts[spaceId]?.context?.length ?? 0,
});

function ctx(
  surface: "discord" | "slack" | "buzz",
  spaceId: string,
  userId: string | undefined,
  isPrivate?: boolean,
): ToolContext {
  return {
    space: { surface, spaceId },
    isPrivate,
    owner: userId ? { userId, displayName: "x" } : null,
    memory: {
      count: (sid: string) => memoryCounts[sid]?.entries ?? 0,
      getServerContext: (sid: string) => memoryCounts[sid]?.context ?? null,
    },
  } as unknown as ToolContext;
}

const PRINCIPALS: Record<string, PrincipalConfig> = {
  drk: { owner: true, identities: { discord: "100", slack: "U100" } },
  alice: { identities: { slack: "U200" } },
  bob: { identities: { slack: "U300" } },
};

const COMMUNITIES: Record<string, CommunityConfig> = {
  dreamcatcher: {
    spaces: [
      { surface: "discord", spaceId: "G1" },
      { surface: "slack", spaceId: "T1" },
      { surface: "buzz", spaceId: "buzz:https://relay.example" },
    ],
    linear: { apiKey: "lin_secret_key", teamId: "DREAM" },
    members: { drk: { trusted: true }, alice: { trusted: true }, bob: {} },
  },
  other: { spaces: [{ surface: "slack", spaceId: "T2" }], members: { bob: { trusted: true } } },
};

describe("team_config", () => {
  const prev = {
    principals: config.principals,
    communities: config.communities,
    guildConfig: config.guildConfig,
    avatarMap: config.buzz.avatarMap,
    wikiMap: config.buzz.wikiMap,
  };
  beforeEach(() => {
    config.principals = PRINCIPALS;
    config.communities = COMMUNITIES;
    config.guildConfig = {
      G1: {
        allowedRoles: ["R1"],
        promptTemplate: "general",
        enabledModules: ["wiki-sync"],
        modRoleId: "MODROLE1",
        alertsChannelId: "ALERTS1",
        mcpBridgeAllowedUserIds: ["999"],
      },
    };
    config.buzz.avatarMap = { "https://relay.example": "https://relay.example/avatar.png" };
    config.buzz.wikiMap = { "https://relay.example": "G1" };
  });
  afterEach(() => {
    config.principals = prev.principals;
    config.communities = prev.communities;
    config.guildConfig = prev.guildConfig;
    config.buzz.avatarMap = prev.avatarMap;
    config.buzz.wikiMap = prev.wikiMap;
  });

  test("resolves every space of the team from any one of its spaces", () => {
    const view = resolveTeamConfig("slack", "T1", stats, true);
    expect(view.team?.id).toBe("dreamcatcher");
    expect(view.team?.owner).toBe("drk");
    expect(view.team?.trustedMembers).toEqual(["alice"]);
    expect(view.spaces.map((s) => s.spaceId)).toEqual(["G1", "T1", "buzz:https://relay.example"]);

    const discord = Object.fromEntries(view.spaces[0]!.settings);
    expect(discord["persona"]).toBe("general");
    expect(discord["modules"]).toBe("wiki-sync");
    expect(discord["memory entries"]).toBe("3");

    const buzz = Object.fromEntries(view.spaces[2]!.settings);
    expect(buzz["avatar"]).toBe("https://relay.example/avatar.png");
    expect(buzz["reads wiki of guild"]).toBe("G1");
  });

  test("a space outside any team shows only itself", () => {
    const view = resolveTeamConfig("slack", "T9", stats);
    expect(view.team).toBeUndefined();
    expect(view.spaces).toHaveLength(1);
  });

  test("detailed=false redacts auto-mod internals and MCP bridge users; detailed=true shows them", () => {
    const redacted = Object.fromEntries(resolveTeamConfig("discord", "G1", stats, false).spaces[0]!.settings);
    expect(redacted["auto-mod"]).toBe("configured (details only in a DM)");
    expect(redacted["MCP bridge users"]).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain("MODROLE1");
    expect(JSON.stringify(redacted)).not.toContain("999");

    const detailed = Object.fromEntries(resolveTeamConfig("discord", "G1", stats, true).spaces[0]!.settings);
    expect(detailed["auto-mod"]).toContain("MODROLE1");
    expect(detailed["MCP bridge users"]).toBe("999");
  });

  test("trusted member sees their team without secrets, redacted in a public channel", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T1", "U200", false));
    expect(r.content).toContain("Team: dreamcatcher");
    expect(r.content).toContain("- owner: drk");
    expect(r.content).toContain("trusted members (besides owner): alice");
    expect(r.content).toContain("slack T1 (this space)");
    expect(r.content).toContain("team DREAM");
    expect(r.content).not.toContain("lin_secret_key");
    expect(r.content).not.toContain("MODROLE1");
    expect(r.content).not.toContain("999");
    expect(r.content).toContain("details only in a DM");
    // No memory content ever crosses the port — only the aggregate count/length.
    expect(r.content).not.toContain(SERVER_CONTEXT_BODY);
    expect(r.content).toContain(`${SERVER_CONTEXT_BODY.length} chars`);
  });

  test("trusted member in a DM (private) sees full auto-mod detail", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T1", "U200", true));
    expect(r.content).toContain("MODROLE1");
    expect(r.content).toContain("999");
  });

  test("owner is authorized in any team", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T2", "U100"));
    expect(r.content).toContain("Team: other");
  });

  test("untrusted member and a member of another team are denied", async () => {
    expect((await teamConfigEntry.execute({}, ctx("slack", "T1", "U300"))).content).toContain("trusted team members");
    expect((await teamConfigEntry.execute({}, ctx("slack", "T1", "U999"))).content).toContain("trusted team members");
    expect((await teamConfigEntry.execute({}, ctx("slack", "T1", undefined))).content).toContain("trusted team members");
  });

  test("a Discord DM (placeholder spaceId, no team) gets the short DM message", async () => {
    const r = await teamConfigEntry.execute({}, ctx("discord", "dm", "100", true));
    expect(r.content).toBe("DMs aren't part of a team; ask from a team channel.");
  });

  test("a Slack DM shares the workspace teamId and still resolves its team", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T2", "U100", true));
    expect(r.content).toContain("Team: other");
    expect(r.content).not.toContain("aren't part of a team");
  });

  describe("legacy (principals unconfigured) branch", () => {
    const prevOwner = config.ownerDiscordId;
    beforeEach(() => {
      config.principals = {};
      config.ownerDiscordId = "100";
    });
    afterEach(() => {
      config.ownerDiscordId = prevOwner;
    });

    test("the legacy owner id is authorized and sees its team, with no owner: line (ownerPrincipalId unset)", async () => {
      const r = await teamConfigEntry.execute({}, ctx("discord", "G1", "100"));
      expect(r.content).toContain("Team: dreamcatcher");
      expect(r.content).not.toContain("- owner:");
    });

    test("anyone else is denied as owner-only", async () => {
      const r = await teamConfigEntry.execute({}, ctx("discord", "G1", "200"));
      expect(r.content).toBe("This tool is owner-only.");
    });
  });
});

describe("parseCommunities", () => {
  test("rejects a non-object top level", () => {
    expect(() => parseCommunities(null)).toThrow(/communities:/);
    expect(() => parseCommunities([])).toThrow(/communities:/);
    expect(() => parseCommunities("nope")).toThrow(/communities:/);
  });

  test("rejects an entry that isn't an object", () => {
    expect(() => parseCommunities({ a: "nope" })).toThrow(/"a"/);
  });

  test("rejects spaces that isn't an array", () => {
    expect(() => parseCommunities({ a: { spaces: "nope" } })).toThrow(/spaces/);
  });

  test("rejects a space missing surface or spaceId", () => {
    expect(() => parseCommunities({ a: { spaces: [{ spaceId: "G1" }] } })).toThrow(/surface/);
    expect(() => parseCommunities({ a: { spaces: [{ surface: "discord" }] } })).toThrow(/spaceId/);
    expect(() => parseCommunities({ a: { spaces: [{ surface: "", spaceId: "G1" }] } })).toThrow(/spaces/);
  });

  test("rejects members that isn't an object of objects", () => {
    expect(() => parseCommunities({ a: { spaces: [], members: "nope" } })).toThrow(/members/);
    expect(() => parseCommunities({ a: { spaces: [], members: { alice: "nope" } } })).toThrow(/members/);
  });

  test("normalizes a buzz spaceId the same way the relay poll loop does", () => {
    const out = parseCommunities({
      a: { spaces: [{ surface: "buzz", spaceId: "buzz:wss://Relay.Example/" }] },
    });
    expect(out["a"]!.spaces[0]!.spaceId).toBe("buzz:https://relay.example");
  });

  test("keeps linear and wiki through parsing", () => {
    const out = parseCommunities({
      a: { spaces: [{ surface: "discord", spaceId: "G1" }], linear: { apiKey: "k", teamId: "T" }, wiki: { wikiId: "G1" } },
    });
    expect(out["a"]!.linear).toEqual({ apiKey: "k", teamId: "T" });
    expect(out["a"]!.wiki).toEqual({ wikiId: "G1" });
  });

  test("two differently-spelled buzz spaceIds normalize to the same space and collide as a duplicate", () => {
    const out = parseCommunities({
      a: { spaces: [{ surface: "buzz", spaceId: "buzz:wss://Relay.Example/" }] },
      b: { spaces: [{ surface: "buzz", spaceId: "buzz:https://relay.example" }] },
    });
    expect(() => buildCommunityIndex(out)).toThrow(/claimed by both/);
  });
});
