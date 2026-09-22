import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { PrincipalConfig } from "./principals.ts";
import { can, isPersonalSpace, spaceKey } from "./authz.ts";

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

  test("the owner principal in a PUBLIC space (isPrivate false/absent) is denied", () => {
    expect(can({ principal: DRK_SLACK, capability: "runner.dispatch", space: spaceKey("slack", "C-public"), isPrivate: false })).toBe(false);
    expect(can({ principal: DRK_DISCORD, capability: "runner.dispatch", space: GUILD_SPACE })).toBe(false);
  });

  test("a right-id/wrong-surface caller is denied (identities are surface-scoped)", () => {
    // drk's slack id presented on the discord surface resolves to no principal.
    expect(can({ principal: DRK_SLACK, capability: "runner.dispatch", space: DM_SPACE, isPrivate: true })).toBe(false);
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
