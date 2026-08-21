import { describe, expect, test } from "bun:test";
import { getPermittedGuildIds, resolvedModules, type GuildConfig } from "./guildConfig.ts";

function cfg(mcpBridgeAllowedUserIds?: string[]): GuildConfig {
  return { allowedRoles: [], mcpBridgeAllowedUserIds };
}

describe("getPermittedGuildIds", () => {
  test("user whitelisted in one guild gets scoped access", () => {
    const guildConfig = { a: cfg(["u1"]), b: cfg(["u2"]) };
    expect(getPermittedGuildIds(guildConfig, "u1")).toEqual(["a"]);
  });

  test("user whitelisted in multiple guilds gets all of them", () => {
    const guildConfig = { a: cfg(["u1"]), b: cfg(["u1", "u2"]), c: cfg(["u2"]) };
    expect(getPermittedGuildIds(guildConfig, "u1").sort()).toEqual(["a", "b"]);
  });

  test("non-whitelisted user gets an empty set", () => {
    const guildConfig = { a: cfg(["u1"]) };
    expect(getPermittedGuildIds(guildConfig, "unknown")).toEqual([]);
  });

  test("guild with no whitelist field is never permitted", () => {
    const guildConfig = { a: cfg(undefined) };
    expect(getPermittedGuildIds(guildConfig, "u1")).toEqual([]);
  });
});

// Regression guard for the modular-architecture refactor: every guild configured before
// enabledModules existed must keep exactly today's (moderation-only) behavior on deploy,
// with zero changes to guild-config.json required.
describe("resolvedModules", () => {
  test("guild config with no enabledModules field defaults to moderation-only", () => {
    expect(resolvedModules({ allowedRoles: [] })).toEqual(["moderation"]);
  });

  test("explicit enabledModules is honored as-is", () => {
    expect(resolvedModules({ allowedRoles: [], enabledModules: ["moderation", "wiki-sync"] })).toEqual([
      "moderation",
      "wiki-sync",
    ]);
  });

  test("explicit empty enabledModules array is honored, not defaulted (?? only fires on undefined)", () => {
    expect(resolvedModules({ allowedRoles: [], enabledModules: [] })).toEqual([]);
  });
});
