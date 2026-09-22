import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { PrincipalConfig } from "./principals.ts";
import type { CommunityConfig } from "./communities.ts";
import { can, isAuthorized, isPersonalSpace, spaceKey } from "./authz.ts";

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

// The unconfigured (legacy) regime is only reachable with an EMPTY registry; principals.json seeds a
// non-empty one by default, so these suites reassign config.principals = {} (never mutate in place).
describe("authz.can — UNCONFIGURED registry (legacy two-check, default-deny)", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;

  beforeEach(() => {
    config.ownerDiscordId = OWNER;
    config.principals = {};
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
  });

  test("owner in a personal/DM space is allowed", () => {
    expect(can({ principal: OWNER, capability: "runner.dispatch", space: DM_SPACE })).toBe(true);
    expect(can({ principal: OWNER, capability: "session.read", space: DM_SPACE })).toBe(true);
  });

  test("non-owner is denied even in a personal/DM space", () => {
    expect(can({ principal: "not-the-owner", capability: "runner.dispatch", space: DM_SPACE })).toBe(false);
  });

  test("owner is denied in a guild/shared space", () => {
    expect(can({ principal: OWNER, capability: "runner.dispatch", space: GUILD_SPACE })).toBe(false);
    expect(can({ principal: OWNER, capability: "session.read", space: GUILD_SPACE })).toBe(false);
  });

  test("non-owner in a guild/shared space is denied (both checks fail)", () => {
    expect(can({ principal: "not-the-owner", capability: "runner.dispatch", space: GUILD_SPACE })).toBe(false);
  });

  test("unrecognized space never offers a capability, even for the owner", () => {
    expect(can({ principal: OWNER, capability: "runner.dispatch", space: "discord:some-other-space" })).toBe(false);
  });

  test("default-deny when config.ownerDiscordId is unset", () => {
    config.ownerDiscordId = undefined;
    expect(can({ principal: OWNER, capability: "runner.dispatch", space: DM_SPACE })).toBe(false);
  });

  test("resource is accepted but does not itself grant access", () => {
    expect(
      can({ principal: OWNER, capability: "session.read", resource: "task-1", space: GUILD_SPACE }),
    ).toBe(false);
  });

  test("an empty registry does not leak even with a DM-shaped space + isPrivate present", () => {
    // The new isPrivate signal + a personal-space key must NOT widen the legacy regime: a stranger
    // (a buzz pubkey that isn't the legacy ownerDiscordId) is still denied.
    config.ownerDiscordId = DRK_DISCORD;
    expect(
      can({ principal: DRK_BUZZ, capability: "runner.dispatch", space: spaceKey("buzz", "dm"), isPrivate: true }),
    ).toBe(false);
  });
});

describe("authz.can — CONFIGURED registry (principal-aware, owner-only, DM-only)", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;

  beforeEach(() => {
    // No legacy ownerDiscordId — the registry is the sole owner source in this regime.
    config.ownerDiscordId = undefined;
    config.principals = DRK_REGISTRY;
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
  });

  test("the owner principal in a private DM on ANY surface is allowed (Slack teamId space)", () => {
    const slackDm = spaceKey("slack", "T0AAA"); // Slack DM spaceId is the teamId, not "dm"
    expect(can({ principal: DRK_SLACK, capability: "runner.dispatch", space: slackDm, isPrivate: true })).toBe(true);
    expect(can({ principal: DRK_SLACK, capability: "session.stop", space: slackDm, isPrivate: true })).toBe(true);
  });

  test("the owner principal in a Discord DM is allowed", () => {
    expect(can({ principal: DRK_DISCORD, capability: "runner.dispatch", space: DM_SPACE, isPrivate: true })).toBe(true);
  });

  test("a non-owner (unlinked) id in a private DM is denied", () => {
    expect(can({ principal: "not-linked", capability: "runner.dispatch", space: spaceKey("slack", "T0AAA"), isPrivate: true })).toBe(false);
  });

  test("the owner principal in a PUBLIC space is allowed (owner tools are not DM-restricted)", () => {
    expect(can({ principal: DRK_SLACK, capability: "runner.dispatch", space: spaceKey("slack", "C-public"), isPrivate: false })).toBe(true);
    expect(can({ principal: DRK_DISCORD, capability: "runner.dispatch", space: GUILD_SPACE })).toBe(true);
  });

  test("a NON-owner in a PUBLIC space is still denied (the owner gate is what protects it)", () => {
    expect(can({ principal: "not-linked", capability: "runner.dispatch", space: spaceKey("slack", "C-public"), isPrivate: false })).toBe(false);
  });

  test("a right-id/wrong-surface caller is denied (identities are surface-scoped)", () => {
    // drk's slack id presented on the discord surface resolves to no principal.
    expect(can({ principal: DRK_SLACK, capability: "runner.dispatch", space: DM_SPACE, isPrivate: true })).toBe(false);
  });
});

// Per-community authorization: the owner is authorized everywhere; a community-trusted member is
// authorized only within that community's spaces. All ids are placeholders (public repo).
const MEMBER_A_DISCORD = "200000000000000000";
const MEMBER_A_SLACK = "U0MEMBERA00";
const GUEST_DISCORD = "300000000000000000";
const DC_DISCORD = "2000000000000000001"; // dreamcatcher's discord guild space
const DC_SLACK = "T00TEAMDC0"; // dreamcatcher's slack team space
const OTHER_DISCORD = "2000000000000000002"; // a different community's space

const AUTHZ_REGISTRY: Record<string, PrincipalConfig> = {
  drk: { owner: true, identities: { discord: DRK_DISCORD, slack: DRK_SLACK, buzz: DRK_BUZZ } },
  // member-a is a vetted person, NOT the owner, linked across discord + slack.
  "member-a": { identities: { discord: MEMBER_A_DISCORD, slack: MEMBER_A_SLACK } },
  // guest resolves to a principal but is trusted in no community → authorized nowhere.
  guest: { identities: { discord: GUEST_DISCORD } },
};

const AUTHZ_COMMUNITIES: Record<string, CommunityConfig> = {
  dreamcatcher: {
    spaces: [
      { surface: "discord", spaceId: DC_DISCORD },
      { surface: "slack", spaceId: DC_SLACK },
    ],
    members: { "member-a": { trusted: true } },
  },
  // A different community with no members — member-a is a stranger here.
  other: { spaces: [{ surface: "discord", spaceId: OTHER_DISCORD }] },
};

describe("authz.isAuthorized + can() — per-community trusted members", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;
  const prevCommunities = config.communities;

  beforeEach(() => {
    config.ownerDiscordId = undefined;
    config.principals = AUTHZ_REGISTRY;
    config.communities = AUTHZ_COMMUNITIES;
  });
  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
    config.communities = prevCommunities;
  });

  test("the owner is authorized in ANY space (DM + guild, any surface)", () => {
    expect(isAuthorized("discord", DRK_DISCORD, DM_SPACE)).toBe(true);
    expect(isAuthorized("discord", DRK_DISCORD, spaceKey("discord", "any-guild"))).toBe(true);
    expect(isAuthorized("slack", DRK_SLACK, spaceKey("slack", "C-public"))).toBe(true);
    // even a space that belongs to no community.
    expect(isAuthorized("discord", DRK_DISCORD, spaceKey("discord", "9999999999999999999"))).toBe(true);
  });

  test("a trusted member is authorized within their community's spaces, across linked identities", () => {
    expect(isAuthorized("discord", MEMBER_A_DISCORD, spaceKey("discord", DC_DISCORD))).toBe(true);
    expect(isAuthorized("slack", MEMBER_A_SLACK, spaceKey("slack", DC_SLACK))).toBe(true);
  });

  test("a trusted member is DENIED in a different community's space and in a space with no community", () => {
    expect(isAuthorized("discord", MEMBER_A_DISCORD, spaceKey("discord", OTHER_DISCORD))).toBe(false);
    expect(isAuthorized("discord", MEMBER_A_DISCORD, spaceKey("discord", "9999999999999999999"))).toBe(false);
  });

  test("a resolved-but-untrusted principal and an unresolved id are denied everywhere", () => {
    expect(isAuthorized("discord", GUEST_DISCORD, spaceKey("discord", DC_DISCORD))).toBe(false);
    expect(isAuthorized("discord", "not-a-principal", spaceKey("discord", DC_DISCORD))).toBe(false);
    // right id, wrong surface → resolves to no principal.
    expect(isAuthorized("discord", MEMBER_A_SLACK, spaceKey("discord", DC_DISCORD))).toBe(false);
  });

  test("can() grants an owner-capability to a trusted member in-community, denies it out-of-community", () => {
    expect(can({ principal: MEMBER_A_DISCORD, capability: "runner.dispatch", space: spaceKey("discord", DC_DISCORD) })).toBe(true);
    expect(can({ principal: MEMBER_A_SLACK, capability: "session.stop", space: spaceKey("slack", DC_SLACK) })).toBe(true);
    expect(can({ principal: MEMBER_A_DISCORD, capability: "runner.dispatch", space: spaceKey("discord", OTHER_DISCORD) })).toBe(false);
    // a resolved-but-untrusted principal gets nothing even in a community space.
    expect(can({ principal: GUEST_DISCORD, capability: "runner.dispatch", space: spaceKey("discord", DC_DISCORD) })).toBe(false);
  });
});

describe("authz.isPersonalSpace", () => {
  test("known personal/DM spaces", () => {
    expect(isPersonalSpace(DM_SPACE)).toBe(true);
    expect(isPersonalSpace(spaceKey("buzz", "dm"))).toBe(true);
  });

  test("a guild/shared space is not personal", () => {
    expect(isPersonalSpace(GUILD_SPACE)).toBe(false);
  });
});
