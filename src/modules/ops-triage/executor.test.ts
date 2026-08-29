import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Client } from "discord.js";
import { config } from "../../config.ts";
import type { ToolContext } from "../registry.ts";
import { OPS_TRIAGE_DISPATCH } from "./executor.ts";

function fakeClient(): Client<true> {
  return {} as unknown as Client<true>;
}

function ctx(triggeringUserId: string | undefined): ToolContext {
  return { guildId: "guild1", client: fakeClient(), triggeringUserId };
}

const ORIGINAL = {
  ownerDiscordId: config.ownerDiscordId,
  grafanaBaseUrl: config.grafanaBaseUrl,
  linearApiKey: config.linearApiKey,
  linearTeamId: config.linearTeamId,
};

beforeEach(() => {
  config.ownerDiscordId = undefined;
  config.grafanaBaseUrl = undefined;
  config.linearApiKey = undefined;
  config.linearTeamId = undefined;
});

afterEach(() => {
  Object.assign(config, ORIGINAL);
});

// Every ops-triage tool must refuse to run for anyone but the configured owner, checked at
// execution time (not just at tool-list assembly) — see registry.ts's ToolContext comment.
describe("ops-triage owner gate", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["search_logs", { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:05:00Z" }],
    ["file_linear_issue", { title: "t", description: "d", repo_label: "sushii-bot" }],
    ["get_issue_status", { issue_id: "ENG-1" }],
    ["list_triaged_issues", {}],
  ];

  for (const [tool, input] of cases) {
    test(`${tool} is refused when OWNER_DISCORD_ID is unset`, async () => {
      const result = await OPS_TRIAGE_DISPATCH[tool](input, ctx("someone"));
      expect(result).toEqual({ tool: "error", message: "ops-triage is not configured (OWNER_DISCORD_ID unset)." });
    });

    test(`${tool} is refused for a caller who isn't the owner`, async () => {
      config.ownerDiscordId = "owner-id";
      const result = await OPS_TRIAGE_DISPATCH[tool](input, ctx("not-the-owner"));
      expect(result).toEqual({ tool: "error", message: "This tool is owner-only." });
    });

    test(`${tool} is refused when no triggering user is set at all`, async () => {
      config.ownerDiscordId = "owner-id";
      const result = await OPS_TRIAGE_DISPATCH[tool](input, ctx(undefined));
      expect(result).toEqual({ tool: "error", message: "This tool is owner-only." });
    });
  }
});

describe("search_logs input validation", () => {
  test("rejects an invalid since/until before ever reaching Grafana — no GRAFANA_BASE_URL configured proves it never got that far", async () => {
    config.ownerDiscordId = "owner-id";
    const result = await OPS_TRIAGE_DISPATCH.search_logs({ since: "not-a-date", until: "2026-01-01T00:05:00Z" }, ctx("owner-id"));
    expect(result).toEqual({ tool: "error", message: "since/until must be valid ISO 8601 timestamps." });
  });

  test("passes owner gate and date validation, then surfaces the missing Grafana config", async () => {
    config.ownerDiscordId = "owner-id";
    await expect(
      OPS_TRIAGE_DISPATCH.search_logs({ since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:05:00Z" }, ctx("owner-id")),
    ).rejects.toThrow("GRAFANA_BASE_URL is not configured.");
  });
});

describe("file_linear_issue / get_issue_status / list_triaged_issues config validation", () => {
  test("file_linear_issue surfaces the missing Linear config once past the owner gate", async () => {
    config.ownerDiscordId = "owner-id";
    // createTriageIssue checks the team ID before the API key (see linear.ts) — this is that ordering, not a bug.
    await expect(
      OPS_TRIAGE_DISPATCH.file_linear_issue({ title: "t", description: "d", repo_label: "sushii-bot" }, ctx("owner-id")),
    ).rejects.toThrow("LINEAR_TEAM_ID is not configured.");
  });

  test("get_issue_status surfaces the missing Linear config once past the owner gate", async () => {
    config.ownerDiscordId = "owner-id";
    await expect(OPS_TRIAGE_DISPATCH.get_issue_status({ issue_id: "ENG-1" }, ctx("owner-id"))).rejects.toThrow(
      "LINEAR_API_KEY is not configured.",
    );
  });

  test("list_triaged_issues surfaces the missing Linear config once past the owner gate", async () => {
    config.ownerDiscordId = "owner-id";
    await expect(OPS_TRIAGE_DISPATCH.list_triaged_issues({}, ctx("owner-id"))).rejects.toThrow("LINEAR_TEAM_ID is not configured.");
  });
});
