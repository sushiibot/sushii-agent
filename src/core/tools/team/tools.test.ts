import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "../../contracts.ts";
import { config } from "../../../config.ts";
import { buildTeamIndex, parseTeams, type TeamConfig } from "../../../orchestration/teams.ts";
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
  privacyUnverified?: boolean,
): ToolContext {
  return {
    space: { surface, spaceId },
    isPrivate,
    privacyUnverified,
    owner: userId ? { userId, displayName: "x" } : null,
    memory: {
      count: (sid: string) => memoryCounts[sid]?.entries ?? 0,
      getServerContext: (sid: string) => memoryCounts[sid]?.context ?? null,
    },
  } as unknown as ToolContext;
}

const PRINCIPALS: Record<string, PrincipalConfig> = {
  drk: { owner: true, identities: { discord: "100", slack: "U100", buzz: "PUBKEY1" } },
  alice: { identities: { slack: "U200", discord: "200" } },
  bob: { identities: { slack: "U300" } },
};

const TEAMS: Record<string, TeamConfig> = {
  dreamcatcher: {
    spaces: [
      { surface: "discord", spaceId: "G1" },
      { surface: "slack", spaceId: "T1" },
      {
        surface: "buzz",
        spaceId: "buzz:https://relay.example",
        wiki: "read",
        buzz: { avatarUrl: "https://relay.example/avatar.png" },
      },
    ],
    wiki: { wikiId: "G1" },
    linear: { apiKeyEnv: "DREAM_LINEAR_API_KEY", teamId: "DREAM" },
    members: { drk: { trusted: true }, alice: { trusted: true }, bob: {} },
    trustSpaceMembers: true,
  },
  other: { spaces: [{ surface: "slack", spaceId: "T2" }], members: { bob: { trusted: true } } },
};

describe("team_config", () => {
  const prev = {
    principals: config.principals,
    teams: config.teams,
    guildConfig: config.guildConfig,
  };
  beforeEach(() => {
    config.principals = PRINCIPALS;
    config.teams = TEAMS;
    config.guildConfig = {
      G1: {
        allowedRoles: ["R1"],
        promptTemplate: "general",
        enabledModules: ["mcp"],
        modRoleId: "MODROLE1",
        alertsChannelId: "ALERTS1",
        mcpBridgeAllowedUserIds: ["999"],
      },
    };
  });
  afterEach(() => {
    config.principals = prev.principals;
    config.teams = prev.teams;
    config.guildConfig = prev.guildConfig;
  });

  test("resolves every space of the team from any one of its spaces", () => {
    const view = resolveTeamConfig("slack", "T1", stats, true);
    expect(view.team?.id).toBe("dreamcatcher");
    expect(view.team?.owner).toBe("drk");
    expect(view.team?.trustedMembers).toEqual(["alice"]);
    expect(view.spaces.map((s) => s.spaceId)).toEqual(["G1", "T1", "buzz:https://relay.example"]);

    const discord = Object.fromEntries(view.spaces[0]!.settings);
    expect(discord["persona"]).toBe("general");
    expect(discord["modules"]).toBe("mcp");
    expect(discord["memory entries"]).toBe("3");

    const buzz = Object.fromEntries(view.spaces[2]!.settings);
    expect(buzz["avatar"]).toBe("https://relay.example/avatar.png");
    expect(buzz["reads wiki"]).toBe("G1");
  });

  test("trust space members line reflects the team's trustSpaceMembers flag", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T1", "U200", false));
    expect(r.content).toContain("trust space members (slack/buzz): yes");

    // "other" has no trustSpaceMembers set at all.
    const r2 = await teamConfigEntry.execute({}, ctx("slack", "T2", "U100"));
    expect(r2.content).toContain("trust space members (slack/buzz): no");
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

  test("owner in a DM lists every team", async () => {
    const r = await teamConfigEntry.execute({}, ctx("discord", "dm", "100", true));
    expect(r.content).toContain("Teams you can view:");
    expect(r.content).toContain("- dreamcatcher");
    expect(r.content).toContain("- other");
  });

  test("owner in a DM gets a team's detailed view via the team param", async () => {
    const r = await teamConfigEntry.execute({ team: "dreamcatcher" }, ctx("discord", "dm", "100", true));
    expect(r.content).toContain("Team: dreamcatcher");
    expect(r.content).toContain("MODROLE1");
    expect(r.content).not.toContain("lin_secret_key");
    expect((await teamConfigEntry.execute({ team: "nope" }, ctx("discord", "dm", "100", true))).content).toBe('No team "nope".');
  });

  test("a trusted non-owner in a DM is denied (no team owns the DM space)", async () => {
    const r = await teamConfigEntry.execute({ team: "dreamcatcher" }, ctx("discord", "dm", "200", true));
    expect(r.content).toBe("This tool is limited to trusted team members.");
  });

  test("outside a DM, the team param is ignored", async () => {
    const r = await teamConfigEntry.execute({ team: "other" }, ctx("slack", "T1", "U200", false));
    expect(r.content).toContain("Team: dreamcatcher");
  });

  test("an unverified private flag (buzz unknown channel type) does not unlock detail", async () => {
    const r = await teamConfigEntry.execute(
      {},
      ctx("buzz", "buzz:https://relay.example", "PUBKEY1", true, true),
    );
    expect(r.content).toContain("Team: dreamcatcher");
    expect(r.content).toContain("configured (details only in a DM)");
    expect(r.content).not.toContain("MODROLE1");
    expect(r.content).not.toContain("999");
  });

  test("a Slack DM shares the workspace teamId and still resolves its team", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T2", "U100", true));
    expect(r.content).toContain("Team: other");
    expect(r.content).not.toContain("aren't part of a team");
  });

  describe("a synthesized owner (no principals.json, OWNER_DISCORD_ID set)", () => {
    beforeEach(() => {
      config.principals = { owner: { owner: true, identities: { discord: "100" } } };
    });

    test("the synthesized owner is authorized and sees its team, with the owner: line present", async () => {
      const r = await teamConfigEntry.execute({}, ctx("discord", "G1", "100"));
      expect(r.content).toContain("Team: dreamcatcher");
      expect(r.content).toContain("- owner:");
    });

    test("anyone else is denied as not a trusted team member", async () => {
      const r = await teamConfigEntry.execute({}, ctx("discord", "G1", "200"));
      expect(r.content).toBe("This tool is limited to trusted team members.");
    });
  });
});

describe("parseTeams", () => {
  test("rejects a non-object top level", () => {
    expect(() => parseTeams(null)).toThrow(/teams:/);
    expect(() => parseTeams([])).toThrow(/teams:/);
    expect(() => parseTeams("nope")).toThrow(/teams:/);
  });

  test("rejects an entry that isn't an object", () => {
    expect(() => parseTeams({ a: "nope" })).toThrow(/"a"/);
  });

  test("rejects spaces that isn't an array", () => {
    expect(() => parseTeams({ a: { spaces: "nope" } })).toThrow(/spaces/);
  });

  test("rejects a space missing surface or spaceId", () => {
    expect(() => parseTeams({ a: { spaces: [{ spaceId: "G1" }] } })).toThrow(/surface/);
    expect(() => parseTeams({ a: { spaces: [{ surface: "discord" }] } })).toThrow(/spaceId/);
    expect(() => parseTeams({ a: { spaces: [{ surface: "", spaceId: "G1" }] } })).toThrow(/spaces/);
  });

  test("rejects members that isn't an object of objects", () => {
    expect(() => parseTeams({ a: { spaces: [], members: "nope" } })).toThrow(/members/);
    expect(() => parseTeams({ a: { spaces: [], members: { alice: "nope" } } })).toThrow(/members/);
  });

  test("rejects a non-boolean trusted flag", () => {
    expect(() => parseTeams({ a: { spaces: [], members: { alice: { trusted: "yes" } } } })).toThrow(/trusted/);
    expect(() => parseTeams({ a: { spaces: [], members: { alice: {} } } })).not.toThrow();
    expect(() => parseTeams({ a: { spaces: [], members: { alice: { trusted: true } } } })).not.toThrow();
  });

  test("normalizes a buzz spaceId the same way the relay poll loop does", () => {
    const out = parseTeams({
      a: { spaces: [{ surface: "buzz", spaceId: "buzz:wss://Relay.Example/" }] },
    });
    expect(out["a"]!.spaces[0]!.spaceId).toBe("buzz:https://relay.example");
  });

  test("keeps linear and wiki through parsing", () => {
    const out = parseTeams({
      a: { spaces: [{ surface: "discord", spaceId: "G1" }], linear: { apiKeyEnv: "K", teamId: "T" }, wiki: { wikiId: "G1" } },
    });
    expect(out["a"]!.linear).toEqual({ apiKeyEnv: "K", teamId: "T" });
    expect(out["a"]!.wiki).toEqual({ wikiId: "G1" });
  });

  test("two differently-spelled buzz spaceIds normalize to the same space and collide as a duplicate", () => {
    const out = parseTeams({
      a: { spaces: [{ surface: "buzz", spaceId: "buzz:wss://Relay.Example/" }] },
      b: { spaces: [{ surface: "buzz", spaceId: "buzz:https://relay.example" }] },
    });
    expect(() => buildTeamIndex(out)).toThrow(/claimed by both/);
  });
});
