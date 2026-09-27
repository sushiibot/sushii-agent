import { describe, expect, mock, test } from "bun:test";
import { resolveOwnerPrincipals } from "./config.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";

describe("resolveOwnerPrincipals", () => {
  test("missing/empty registry + OWNER_DISCORD_ID set synthesizes a single owner principal", () => {
    const warn = mock();
    expect(resolveOwnerPrincipals({}, "100000000000000000", warn)).toEqual({
      owner: { owner: true, identities: { discord: "100000000000000000" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("neither set stays empty — nobody is owner, no warning", () => {
    const warn = mock();
    expect(resolveOwnerPrincipals({}, undefined, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("a non-empty registry is used as-is, never merged with OWNER_DISCORD_ID", () => {
    const raw: Record<string, PrincipalConfig> = {
      drk: { owner: true, identities: { discord: "100000000000000000", slack: "U1" } },
      alice: { identities: { discord: "200000000000000000" } },
    };
    expect(resolveOwnerPrincipals(raw, "999999999999999999")).toBe(raw);
  });

  test("a registry with members but no declared owner is used as-is, not synthesized over, no warning", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { alice: { identities: { discord: "200000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000", warn)).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a matching file owner + OWNER_DISCORD_ID logs no warning and returns the file as-is", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000", warn)).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a mismatched file owner + OWNER_DISCORD_ID warns once and still returns the file as-is (file wins)", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "999999999999999999", warn)).toBe(raw);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({
      principalId: "drk",
      fileOwnerDiscord: "100000000000000000",
      ownerDiscordId: "999999999999999999",
    });
  });
});
