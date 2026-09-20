import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { can, isPersonalSpace, spaceKey } from "./authz.ts";

const OWNER = "owner-123";
const DM_SPACE = spaceKey("discord", "dm");
const GUILD_SPACE = spaceKey("discord", "guild-456");

describe("authz.can (two-check, default-deny)", () => {
  const prevOwner = config.ownerDiscordId;

  beforeEach(() => {
    config.ownerDiscordId = OWNER;
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
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
