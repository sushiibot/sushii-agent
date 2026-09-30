import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { PrincipalConfig } from "./principals.ts";
import type { TeamConfig } from "./teams.ts";
import { isAuthorized, isPersonalSpace, spaceKey } from "./authz.ts";

const OWNER = "owner-123";
const DM_SPACE = spaceKey("discord", "dm");
const GUILD_SPACE = spaceKey("discord", "guild-456");

// drk's real identity ids (mirrors principals.json) for the configured-registry suite.
const DRK_DISCORD = "100000000000000000";
const DRK_SLACK = "U0OWNERTEST0";
const DRK_BUZZ = "00000000000000000000000000000000000000000000000000000000deadbeef";
const DRK_REGISTRY: Record<string, PrincipalConfig> = {
  drk: { owner: true, identities: { discord: DRK_DISCORD, slack: DRK_SLACK, buzz: DRK_BUZZ } },
};

describe("authz.isAuthorized — no owner configured (empty registry, default-deny)", () => {
  const prevPrincipals = config.principals;

  beforeEach(() => {
    config.principals = {};
  });

  afterEach(() => {
    config.principals = prevPrincipals;
  });

  test("nobody is authorized, in a personal/DM or a guild/shared space", () => {
    expect(isAuthorized("discord", OWNER, DM_SPACE)).toBe(false);
    expect(isAuthorized("discord", OWNER, GUILD_SPACE)).toBe(false);
    expect(isAuthorized("buzz", DRK_BUZZ, spaceKey("buzz", "dm"))).toBe(false);
  });
});

describe("authz.isAuthorized — principal registry (owner, NOT DM-restricted)", () => {
  const prevPrincipals = config.principals;

  beforeEach(() => {
    config.principals = DRK_REGISTRY;
  });

  afterEach(() => {
    config.principals = prevPrincipals;
  });

  test("the owner principal is authorized on any surface, private or public", () => {
    expect(isAuthorized("slack", DRK_SLACK, spaceKey("slack", "T0AAA"))).toBe(true);
    expect(isAuthorized("discord", DRK_DISCORD, DM_SPACE)).toBe(true);
    expect(isAuthorized("slack", DRK_SLACK, spaceKey("slack", "C-public"))).toBe(true);
    expect(isAuthorized("discord", DRK_DISCORD, GUILD_SPACE)).toBe(true);
  });

  test("a non-owner (unlinked) id is denied", () => {
    expect(isAuthorized("slack", "not-linked", spaceKey("slack", "T0AAA"))).toBe(false);
    expect(isAuthorized("slack", "not-linked", spaceKey("slack", "C-public"))).toBe(false);
  });

  test("a right-id/wrong-surface caller is denied (identities are surface-scoped)", () => {
    expect(isAuthorized("discord", DRK_SLACK, DM_SPACE)).toBe(false);
  });
});

// Per-team authorization: the owner is authorized everywhere; a team-trusted member is
// authorized only within that team's spaces. All ids are placeholders (public repo).
const MEMBER_A_DISCORD = "200000000000000000";
const MEMBER_A_SLACK = "U0MEMBERA00";
const GUEST_DISCORD = "300000000000000000";
const DC_DISCORD = "2000000000000000001"; // dreamcatcher's discord guild space
const DC_SLACK = "T00TEAMDC0"; // dreamcatcher's slack team space
const OTHER_DISCORD = "2000000000000000002"; // a different team's space

const AUTHZ_REGISTRY: Record<string, PrincipalConfig> = {
  drk: { owner: true, identities: { discord: DRK_DISCORD, slack: DRK_SLACK, buzz: DRK_BUZZ } },
  // member-a is a vetted person, NOT the owner, linked across discord + slack.
  "member-a": { identities: { discord: MEMBER_A_DISCORD, slack: MEMBER_A_SLACK } },
  // guest resolves to a principal but is trusted in no team → authorized nowhere.
  guest: { identities: { discord: GUEST_DISCORD } },
};

const AUTHZ_TEAMS: Record<string, TeamConfig> = {
  dreamcatcher: {
    spaces: [
      { surface: "discord", spaceId: DC_DISCORD },
      { surface: "slack", spaceId: DC_SLACK },
    ],
    members: { "member-a": { trusted: true } },
  },
  // A different team with no members — member-a is a stranger here.
  other: { spaces: [{ surface: "discord", spaceId: OTHER_DISCORD }] },
};

describe("authz.isAuthorized — per-team trusted members", () => {
  const prevPrincipals = config.principals;
  const prevTeams = config.teams;

  beforeEach(() => {
    config.principals = AUTHZ_REGISTRY;
    config.teams = AUTHZ_TEAMS;
  });
  afterEach(() => {
    config.principals = prevPrincipals;
    config.teams = prevTeams;
  });

  test("the owner is authorized in ANY space (DM + guild, any surface)", () => {
    expect(isAuthorized("discord", DRK_DISCORD, DM_SPACE)).toBe(true);
    expect(isAuthorized("discord", DRK_DISCORD, spaceKey("discord", "any-guild"))).toBe(true);
    expect(isAuthorized("slack", DRK_SLACK, spaceKey("slack", "C-public"))).toBe(true);
    // even a space that belongs to no team.
    expect(isAuthorized("discord", DRK_DISCORD, spaceKey("discord", "9999999999999999999"))).toBe(true);
  });

  test("a trusted member is authorized within their team's spaces, across linked identities", () => {
    expect(isAuthorized("discord", MEMBER_A_DISCORD, spaceKey("discord", DC_DISCORD))).toBe(true);
    expect(isAuthorized("slack", MEMBER_A_SLACK, spaceKey("slack", DC_SLACK))).toBe(true);
  });

  test("a trusted member is DENIED in a different team's space and in a space with no team", () => {
    expect(isAuthorized("discord", MEMBER_A_DISCORD, spaceKey("discord", OTHER_DISCORD))).toBe(false);
    expect(isAuthorized("discord", MEMBER_A_DISCORD, spaceKey("discord", "9999999999999999999"))).toBe(false);
  });

  test("a resolved-but-untrusted principal and an unresolved id are denied everywhere", () => {
    expect(isAuthorized("discord", GUEST_DISCORD, spaceKey("discord", DC_DISCORD))).toBe(false);
    expect(isAuthorized("discord", "not-a-principal", spaceKey("discord", DC_DISCORD))).toBe(false);
    // right id, wrong surface → resolves to no principal.
    expect(isAuthorized("discord", MEMBER_A_SLACK, spaceKey("discord", DC_DISCORD))).toBe(false);
  });
});

// trustSpaceMembers: a team may vet its private (non-Discord) spaces by membership alone —
// anyone present in them counts as trusted, since the space itself is invite-only. Discord guilds
// are public, so they never get this shortcut regardless of the flag.
const TRUST_TEAMS: Record<string, TeamConfig> = {
  trusting: {
    spaces: [
      { surface: "discord", spaceId: DC_DISCORD },
      { surface: "slack", spaceId: DC_SLACK },
      { surface: "buzz", spaceId: "buzz:https://relay.example" },
    ],
    trustSpaceMembers: true,
  },
  untrusting: {
    spaces: [{ surface: "slack", spaceId: "T00UNTRUSTING" }],
    // trustSpaceMembers absent — defaults to off.
  },
};

describe("authz.isAuthorized — trustSpaceMembers", () => {
  const prevPrincipals = config.principals;
  const prevTeams = config.teams;

  beforeEach(() => {
    config.principals = {}; // no principals.json needed — that's the point of the flag.
    config.teams = TRUST_TEAMS;
  });
  afterEach(() => {
    config.principals = prevPrincipals;
    config.teams = prevTeams;
  });

  test("any non-empty caller is authorized on a trusting team's slack/buzz spaces", () => {
    expect(isAuthorized("slack", "whoever-U1", spaceKey("slack", DC_SLACK))).toBe(true);
    expect(isAuthorized("buzz", "some-pubkey", spaceKey("buzz", "buzz:https://relay.example"))).toBe(true);
  });

  test("a Discord space on the same trusting team still requires an explicit trusted member or owner", () => {
    expect(isAuthorized("discord", "whoever-U1", spaceKey("discord", DC_DISCORD))).toBe(false);
  });

  test("an empty userId is never authorized, even on a trusting team's space", () => {
    expect(isAuthorized("slack", "", spaceKey("slack", DC_SLACK))).toBe(false);
  });

  test("trustSpaceMembers absent/false denies an unlisted caller on that team's space", () => {
    expect(isAuthorized("slack", "whoever-U1", spaceKey("slack", "T00UNTRUSTING"))).toBe(false);
  });

  test("the owner is still authorized on a trusting team's spaces when a registry exists", () => {
    config.principals = DRK_REGISTRY;
    expect(isAuthorized("slack", DRK_SLACK, spaceKey("slack", DC_SLACK))).toBe(true);
    expect(isAuthorized("discord", DRK_DISCORD, spaceKey("discord", DC_DISCORD))).toBe(true);
  });
});

describe("authz.isPersonalSpace", () => {
  test("the known personal/DM space", () => {
    expect(isPersonalSpace(DM_SPACE)).toBe(true);
  });

  test("a guild/shared space, or an unreachable buzz DM space, is not personal", () => {
    expect(isPersonalSpace(GUILD_SPACE)).toBe(false);
    expect(isPersonalSpace(spaceKey("buzz", "dm"))).toBe(false);
  });
});
