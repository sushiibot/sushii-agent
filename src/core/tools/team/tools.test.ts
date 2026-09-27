import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "../../contracts.ts";
import { config } from "../../../config.ts";
import type { CommunityConfig } from "../../../orchestration/communities.ts";
import type { PrincipalConfig } from "../../../orchestration/principals.ts";
import { resolveTeamConfig } from "../../../orchestration/teamConfig.ts";
import { teamConfigEntry } from "./tools.ts";

const memory = {
  count: (spaceId: string) => (spaceId === "G1" ? 3 : 0),
  getServerContext: (spaceId: string) => (spaceId === "G1" ? "ctx" : null),
};

function ctx(surface: "discord" | "slack" | "buzz", spaceId: string, userId: string | undefined): ToolContext {
  return {
    space: { surface, spaceId },
    owner: userId ? { userId, displayName: "x" } : null,
    memory,
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
      { surface: "buzz", spaceId: "buzz:wss://relay.example" },
    ],
    linear: { apiKey: "lin_secret_key", teamId: "DREAM" },
    members: { alice: { trusted: true }, bob: {} },
  },
  other: { spaces: [{ surface: "slack", spaceId: "T2" }], members: { bob: { trusted: true } } },
};

describe("team_config", () => {
  const prev = { principals: config.principals, communities: config.communities, guildConfig: config.guildConfig };
  beforeEach(() => {
    config.principals = PRINCIPALS;
    config.communities = COMMUNITIES;
    config.guildConfig = { G1: { allowedRoles: ["R1"], promptTemplate: "general", enabledModules: ["wiki-sync"] } };
  });
  afterEach(() => {
    config.principals = prev.principals;
    config.communities = prev.communities;
    config.guildConfig = prev.guildConfig;
  });

  test("resolves every space of the team from any one of its spaces", () => {
    const view = resolveTeamConfig("slack", "T1", memory);
    expect(view.team?.id).toBe("dreamcatcher");
    expect(view.team?.trustedMembers).toEqual(["alice"]);
    expect(view.spaces.map((s) => s.spaceId)).toEqual(["G1", "T1", "buzz:wss://relay.example"]);
    const discord = Object.fromEntries(view.spaces[0]!.settings);
    expect(discord["persona"]).toBe("general");
    expect(discord["modules"]).toBe("wiki-sync");
    expect(discord["memory entries"]).toBe("3");
  });

  test("a space outside any team shows only itself", () => {
    const view = resolveTeamConfig("slack", "T9", memory);
    expect(view.team).toBeUndefined();
    expect(view.spaces).toHaveLength(1);
  });

  test("trusted member sees their team without secrets", async () => {
    const r = await teamConfigEntry.execute({}, ctx("slack", "T1", "U200"));
    expect(r.content).toContain("Team: dreamcatcher");
    expect(r.content).toContain("slack T1 (this space)");
    expect(r.content).toContain("team DREAM");
    expect(r.content).not.toContain("lin_secret_key");
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
});
