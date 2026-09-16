import { describe, expect, test } from "bun:test";
import type { SurfaceCapabilities, SurfaceSession, ToolHosts } from "../contracts.ts";
import { ALL_TOOL_ENTRIES, createToolRegistry } from "./registry.ts";
import "./hosts.ts";

const ALL_CAPS: SurfaceCapabilities = {
  richComponents: true,
  customEmoji: true,
  nativeTimestamps: true,
  threads: true,
  reactions: true,
  progress: true,
  interactiveChoices: true,
  typing: true,
  replyTo: true,
};

function fakeSession(hosts: ToolHosts, capabilities: SurfaceCapabilities = ALL_CAPS): SurfaceSession {
  return {
    capabilities,
    renderer: {
      renderText: (text) => text,
      promptGuidance: () => ({ sections: {} }),
      describeUser: () => "user",
    },
    selfId: "bot",
    selfName: "bot",
    deliver: async () => ({}),
    hosts,
  };
}

const SPACE = { surface: "discord" as const, spaceId: "guild1" };

describe("CoreToolRegistry", () => {
  test("no hosts present -> only host-free tools resolve", () => {
    const registry = createToolRegistry();
    const names = registry.resolve(fakeSession({}), SPACE).map((e) => e.name);

    expect(names).toContain("memory");
    expect(names).toContain("web_search");
    expect(names).toContain("search_logs");
    expect(names).not.toContain("get_guild_info");
    expect(names).not.toContain("search_messages");
    expect(names).not.toContain("get_user_mod_history");
  });

  test("discord host present -> discord-gated tools included, messageCache/mcp-only ones excluded", () => {
    const registry = createToolRegistry();
    const names = registry.resolve(fakeSession({ discord: {} as never }), SPACE).map((e) => e.name);

    expect(names).toContain("get_guild_info");
    expect(names).toContain("timeout_member");
    expect(names).not.toContain("search_messages");
    expect(names).not.toContain("get_user_mod_history");
    // delete_user_messages needs both discord AND messageCache
    expect(names).not.toContain("delete_user_messages");
  });

  test("discord + messageCache hosts present -> delete_user_messages included", () => {
    const registry = createToolRegistry();
    const names = registry
      .resolve(fakeSession({ discord: {} as never, messageCache: {} as never }), SPACE)
      .map((e) => e.name);

    expect(names).toContain("delete_user_messages");
    expect(names).toContain("search_messages");
  });

  test("mcp host present -> mcp-gated tools included", () => {
    const registry = createToolRegistry();
    const names = registry.resolve(fakeSession({ mcp: {} as never }), SPACE).map((e) => e.name);

    expect(names).toContain("get_user_mod_history");
    expect(names).toContain("get_user_cross_server_bans");
    expect(names).toContain("get_guild_recent_cases");
  });

  test("interactiveChoices false -> ask_question excluded even with no host requirement", () => {
    const registry = createToolRegistry();
    const caps = { ...ALL_CAPS, interactiveChoices: false };
    const names = registry.resolve(fakeSession({}, caps), SPACE).map((e) => e.name);

    expect(names).not.toContain("ask_question");
    // other host-free tools still resolve
    expect(names).toContain("memory");
  });

  test("interactiveChoices true -> ask_question included", () => {
    const registry = createToolRegistry();
    const names = registry.resolve(fakeSession({}), SPACE).map((e) => e.name);
    expect(names).toContain("ask_question");
  });

  test("every declared tool name is unique", () => {
    const names = ALL_TOOL_ENTRIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
