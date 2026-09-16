import { describe, expect, test } from "bun:test";
import type { SurfaceCapabilities, SurfaceSession, ToolHosts } from "../contracts.ts";
import { ALL_TOOL_ENTRIES, createToolRegistry, type ToolAvailability } from "./registry.ts";
import "./hosts.ts";

const AVAILABLE: ToolAvailability = { exa: true, owner: true, grafanaBaseUrl: true, linear: true };

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

function registry(availability: ToolAvailability = AVAILABLE) {
  return createToolRegistry(undefined, () => availability);
}

describe("CoreToolRegistry", () => {
  test("no hosts present -> only host-free tools resolve", () => {
    const names = registry().resolve(fakeSession({}), SPACE).map((e) => e.name);

    expect(names).toContain("memory");
    expect(names).toContain("web_search");
    expect(names).toContain("search_logs");
    expect(names).not.toContain("get_guild_info");
    expect(names).not.toContain("search_messages");
    expect(names).not.toContain("get_user_mod_history");
  });

  test("discord host present -> discord-gated tools included, messageCache/mcp-only ones excluded", () => {
    const names = registry().resolve(fakeSession({ discord: {} as never }), { ...SPACE, autoMod: true }).map((e) => e.name);

    expect(names).toContain("get_guild_info");
    expect(names).toContain("timeout_member");
    expect(names).not.toContain("search_messages");
    expect(names).not.toContain("get_user_mod_history");
    // delete_user_messages needs both discord AND messageCache
    expect(names).not.toContain("delete_user_messages");
  });

  test("discord + messageCache hosts present -> delete_user_messages included", () => {
    const names = registry()
      .resolve(fakeSession({ discord: {} as never, messageCache: {} as never }), { ...SPACE, autoMod: true })
      .map((e) => e.name);

    expect(names).toContain("delete_user_messages");
    expect(names).toContain("search_messages");
  });

  test("autoMod tools hidden from a conversational (non-auto-mod) turn even with the discord host present", () => {
    const names = registry()
      .resolve(fakeSession({ discord: {} as never, messageCache: {} as never }), SPACE)
      .map((e) => e.name);

    expect(names).not.toContain("timeout_member");
    expect(names).not.toContain("delete_user_messages");
    expect(names).not.toContain("send_alert_message");
    // non-auto-mod-only discord tools stay available
    expect(names).toContain("get_guild_info");
  });

  test("web_search/fetch_url_content hidden when no Exa key is configured", () => {
    const names = registry({ ...AVAILABLE, exa: false }).resolve(fakeSession({}), SPACE).map((e) => e.name);

    expect(names).not.toContain("web_search");
    expect(names).not.toContain("fetch_url_content");
  });

  test("ops-triage Grafana/Linear tools hidden without an owner id, even with credentials set", () => {
    const names = registry({ ...AVAILABLE, owner: false }).resolve(fakeSession({}), SPACE).map((e) => e.name);

    expect(names).not.toContain("search_logs");
    expect(names).not.toContain("get_trace");
    expect(names).not.toContain("file_linear_issue");
  });

  test("Grafana tools hidden without a Grafana base URL, Linear tools unaffected", () => {
    const names = registry({ ...AVAILABLE, grafanaBaseUrl: false }).resolve(fakeSession({}), SPACE).map((e) => e.name);

    expect(names).not.toContain("search_logs");
    expect(names).toContain("file_linear_issue");
  });

  test("Linear tools hidden without both a Linear API key and team id", () => {
    const names = registry({ ...AVAILABLE, linear: false }).resolve(fakeSession({}), SPACE).map((e) => e.name);

    expect(names).not.toContain("file_linear_issue");
    expect(names).toContain("search_logs");
  });

  test("mcp host present -> mcp-gated tools included", () => {
    const names = registry().resolve(fakeSession({ mcp: {} as never }), SPACE).map((e) => e.name);

    expect(names).toContain("get_user_mod_history");
    expect(names).toContain("get_user_cross_server_bans");
    expect(names).toContain("get_guild_recent_cases");
  });

  test("interactiveChoices false -> ask_question excluded even with no host requirement", () => {
    const caps = { ...ALL_CAPS, interactiveChoices: false };
    const names = registry().resolve(fakeSession({}, caps), SPACE).map((e) => e.name);

    expect(names).not.toContain("ask_question");
    // other host-free tools still resolve
    expect(names).toContain("memory");
  });

  test("interactiveChoices true -> ask_question included", () => {
    const names = registry().resolve(fakeSession({}), SPACE).map((e) => e.name);
    expect(names).toContain("ask_question");
  });

  test("default availability (no override) reads the live config singleton without throwing", () => {
    const names = createToolRegistry().resolve(fakeSession({}), SPACE).map((e) => e.name);
    expect(names).toContain("memory");
  });

  test("every declared tool name is unique", () => {
    const names = ALL_TOOL_ENTRIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
