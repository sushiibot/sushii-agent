import { describe, expect, test } from "bun:test";
import { resolveOwnerPrincipals } from "./config.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";

describe("resolveOwnerPrincipals", () => {
  test("missing/empty registry + OWNER_DISCORD_ID set synthesizes a single owner principal", () => {
    expect(resolveOwnerPrincipals({}, "100000000000000000")).toEqual({
      owner: { owner: true, identities: { discord: "100000000000000000" } },
    });
  });

  test("neither set stays empty — nobody is owner", () => {
    expect(resolveOwnerPrincipals({}, undefined)).toEqual({});
  });

  test("a non-empty registry is used as-is, never merged with OWNER_DISCORD_ID", () => {
    const raw: Record<string, PrincipalConfig> = {
      drk: { owner: true, identities: { discord: "100000000000000000", slack: "U1" } },
      alice: { identities: { discord: "200000000000000000" } },
    };
    expect(resolveOwnerPrincipals(raw, "999999999999999999")).toBe(raw);
  });

  test("a registry with members but no declared owner is used as-is, not synthesized over", () => {
    const raw: Record<string, PrincipalConfig> = { alice: { identities: { discord: "200000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000")).toBe(raw);
  });

  test("a matching file owner + OWNER_DISCORD_ID logs no warning and returns the file as-is", () => {
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000")).toBe(raw);
  });

  test("a mismatched file owner + OWNER_DISCORD_ID still returns the file as-is (file wins, warns at load)", () => {
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "999999999999999999")).toBe(raw);
  });
});
