import { describe, expect, test } from "bun:test";
import { getPermittedGuildIds, type GuildConfig } from "./guildConfig.ts";

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
