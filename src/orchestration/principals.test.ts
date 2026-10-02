import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { PrincipalConfig } from "./principals.ts";
import { buildPrincipalIndex, ownerPrincipalId, principalAliasUserIds, resolvePrincipal } from "./principals.ts";

const DRK: Record<string, PrincipalConfig> = {
  drk: {
    owner: true,
    identities: {
      discord: "100000000000000000",
      slack: "U0OWNERTEST0",
      buzz: "00000000000000000000000000000000000000000000000000000000deadbeef",
    },
  },
};

describe("resolvePrincipal", () => {
  const prev = config.principals;
  afterEach(() => {
    // Reassign (never mutate in place) so the reference-identity cache rebuilds.
    config.principals = prev;
  });

  test("each of drk's identities resolves to the same owner principal", () => {
    config.principals = DRK;
    expect(resolvePrincipal("discord", "100000000000000000")).toEqual({ principalId: "drk", isOwner: true });
    expect(resolvePrincipal("slack", "U0OWNERTEST0")).toEqual({ principalId: "drk", isOwner: true });
    expect(resolvePrincipal("buzz", "00000000000000000000000000000000000000000000000000000000deadbeef")).toEqual({
      principalId: "drk",
      isOwner: true,
    });
  });

  test("web identities use the gateway's case-insensitive trimmed login matching", () => {
    config.principals = { drk: { owner: true, identities: { web: "  Owner@Example.COM  ", slack: "CaseSensitive" } } };
    expect(resolvePrincipal("web", "owner@example.com")).toEqual({ principalId: "drk", isOwner: true });
    expect(resolvePrincipal("web", " Owner@Example.com ")).toEqual({ principalId: "drk", isOwner: true });
    expect(resolvePrincipal("web", "other@example.com")).toBeUndefined();
    expect(resolvePrincipal("slack", "casesensitive")).toBeUndefined();
  });

  test("an unknown (surface, userId) resolves to undefined", () => {
    config.principals = DRK;
    expect(resolvePrincipal("discord", "someone-else")).toBeUndefined();
    // Right id, wrong surface — identities are surface-scoped.
    expect(resolvePrincipal("slack", "100000000000000000")).toBeUndefined();
  });

  test("an empty registry resolves everything to undefined and has no owner", () => {
    config.principals = {};
    expect(resolvePrincipal("discord", "100000000000000000")).toBeUndefined();
    expect(ownerPrincipalId()).toBeUndefined();
  });

  test("a two-owner config throws on access", () => {
    config.principals = {
      a: { owner: true, identities: { discord: "1" } },
      b: { owner: true, identities: { discord: "2" } },
    };
    expect(() => resolvePrincipal("discord", "1")).toThrow(/at most one principal may be owner/);
  });

  test("buildPrincipalIndex throws directly on two owners", () => {
    expect(() =>
      buildPrincipalIndex({
        a: { owner: true, identities: {} },
        b: { owner: true, identities: {} },
      }),
    ).toThrow(/at most one principal may be owner/);
  });

  test("principalAliasUserIds returns the principal's OTHER identity userIds", () => {
    config.principals = DRK;
    expect(principalAliasUserIds("drk", "slack", "U0OWNERTEST0").sort()).toEqual(
      ["100000000000000000", "00000000000000000000000000000000000000000000000000000000deadbeef"].sort(),
    );
    expect(principalAliasUserIds("nobody", "slack", "x")).toEqual([]);
  });

  test("ownerPrincipalId resolves for a non-empty registry", () => {
    config.principals = DRK;
    expect(ownerPrincipalId()).toBe("drk");
  });
});
