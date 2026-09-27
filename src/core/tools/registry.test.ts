import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SurfaceCapabilities, SurfaceSession, ToolHosts } from "../contracts.ts";
import { config } from "../../config.ts";
import type { PrincipalConfig } from "../../orchestration/principals.ts";
import { ALL_TOOL_ENTRIES, createToolRegistry, type ToolAvailability } from "./registry.ts";
import "./hosts.ts";

const AVAILABLE: ToolAvailability = { exa: true, grafanaBaseUrl: true, linear: true };

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

// authorized: true so the exa/grafana/linear/host gates below can be tested independently of the
// ops-triage authorization gate, which has its own dedicated tests further down.
const SPACE = { surface: "discord" as const, spaceId: "guild1", authorized: true };

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

  test("ops-triage Grafana/Linear tools hidden from an unauthorized caller, even with credentials set", () => {
    const names = registry().resolve(fakeSession({}), { ...SPACE, authorized: false }).map((e) => e.name);

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

describe("runner/ops gating (author-aware authorized; update_profile stays owner-DM)", () => {
  const prev = config.principals;
  const DRK: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { slack: "U0OWNERTEST0" } } };
  beforeEach(() => {
    config.principals = DRK;
  });
  afterEach(() => {
    config.principals = prev;
  });

  test("owner (authorized) in a private space (ANY surface) sees runner + update_profile tools", () => {
    const names = registry()
      .resolve(fakeSession({}), { surface: "slack", spaceId: "T1", isOwner: true, isPrivate: true, authorized: true })
      .map((e) => e.name);
    expect(names).toContain("dispatch_to_runner");
    expect(names).toContain("update_profile");
  });

  test("owner in a NON-private space gets runner tools but not update_profile; a non-authorized caller gets neither", () => {
    const publicOwner = registry()
      .resolve(fakeSession({}), { surface: "slack", spaceId: "C1", isOwner: true, isPrivate: false, authorized: true })
      .map((e) => e.name);
    // Runner tools gate on `authorized`, not DM — an authorized caller drives runners from a channel too.
    expect(publicOwner).toContain("dispatch_to_runner");
    // update_profile stays owner-DM-first (editing the personal profile shouldn't happen in a shared space).
    expect(publicOwner).not.toContain("update_profile");

    const privateNonAuth = registry()
      .resolve(fakeSession({}), { surface: "slack", spaceId: "T1", isOwner: false, isPrivate: true, authorized: false })
      .map((e) => e.name);
    expect(privateNonAuth).not.toContain("dispatch_to_runner");
    expect(privateNonAuth).not.toContain("update_profile");
  });

  // A community-trusted member is authorized for runner + ops tools but must NOT reach update_profile
  // (that stays behind the owner-DM gate — a trusted member is not the owner).
  test("a trusted member (authorized, not owner) gets runner + ops tools but never update_profile", () => {
    const names = registry()
      .resolve(fakeSession({}), { surface: "slack", spaceId: "C1", isOwner: false, isPrivate: true, authorized: true })
      .map((e) => e.name);
    expect(names).toContain("dispatch_to_runner");
    expect(names).toContain("search_logs");
    expect(names).toContain("file_linear_issue");
    expect(names).not.toContain("update_profile");
  });

  test("the discord:dm space string alone no longer suffices — the authorized/isOwner/isPrivate flags decide", () => {
    const noFlags = registry().resolve(fakeSession({}), { surface: "discord", spaceId: "dm" }).map((e) => e.name);
    expect(noFlags).not.toContain("dispatch_to_runner");
    expect(noFlags).not.toContain("update_profile");
  });

  test("team_config is visible only to an authorized, non-auto-mod caller", () => {
    const names = (space: { authorized?: boolean; autoMod?: boolean }) =>
      registry().resolve(fakeSession({}), { surface: "slack", spaceId: "T1", ...space }).map((e) => e.name);
    expect(names({ authorized: true })).toContain("team_config");
    expect(names({ authorized: false })).not.toContain("team_config");
    expect(names({ authorized: true, autoMod: true })).not.toContain("team_config");
  });

  // ops-triage gates on `authorized` but NOT DM — it stays available in a guild channel.
  test("ops-triage tools visible to an authorized caller in a NON-private (guild) space", () => {
    const names = registry()
      .resolve(fakeSession({}), { surface: "slack", spaceId: "C1", isOwner: true, isPrivate: false, authorized: true })
      .map((e) => e.name);
    expect(names).toContain("search_logs");
    expect(names).toContain("file_linear_issue");
    // runner tools gate the same way, so they're here too; update_profile stays owner-DM-gated.
    expect(names).toContain("dispatch_to_runner");
    expect(names).not.toContain("update_profile");
  });

  test("ops-triage tools hidden from a non-authorized caller even in a private space", () => {
    const names = registry()
      .resolve(fakeSession({}), { surface: "slack", spaceId: "T1", isOwner: false, isPrivate: true, authorized: false })
      .map((e) => e.name);
    expect(names).not.toContain("search_logs");
    expect(names).not.toContain("file_linear_issue");
  });
});
