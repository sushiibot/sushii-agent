import { config } from "../../config.ts";
import type { ToolContext } from "../registry.ts";
import type { ToolResult } from "../moderation/executor.ts";
import { queryLoki, queryTempo } from "./grafana.ts";
import { createTriageIssue, fetchIssueStatus, listTriageIssues } from "./linear.ts";

function requireOwner(ctx: ToolContext): { tool: "error"; message: string } | undefined {
  if (!config.ownerDiscordId) return { tool: "error", message: "ops-triage is not configured (OWNER_DISCORD_ID unset)." };
  if (ctx.triggeringUserId !== config.ownerDiscordId) return { tool: "error", message: "This tool is owner-only." };
  return undefined;
}

export const OPS_TRIAGE_DISPATCH: Record<string, (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>> = {
  search_logs: async (input, ctx) => {
    const denied = requireOwner(ctx);
    if (denied) return denied;

    const since = input.since as string;
    const until = input.until as string;
    const service = input.service as string | undefined;
    const query = input.query as string | undefined;

    const startMs = Date.parse(since);
    const endMs = Date.parse(until);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { tool: "error", message: "since/until must be valid ISO 8601 timestamps." };

    const logs = await queryLoki({ service, query, startMs, endMs });
    const parts = [`Logs ${since} to ${until}${service ? ` (${service})` : ""}:`, logs];

    try {
      const traces = await queryTempo(service, startMs, endMs);
      if (traces) parts.push("", "Traces:", traces);
    } catch (err) {
      parts.push("", `(trace lookup failed: ${err instanceof Error ? err.message : String(err)})`);
    }

    return { tool: "search_logs", data: { summary: parts.join("\n") } };
  },

  file_linear_issue: async (input, ctx) => {
    const denied = requireOwner(ctx);
    if (denied) return denied;

    const title = input.title as string;
    const description = input.description as string;
    const repoLabel = input.repo_label as string;
    const issue = await createTriageIssue(title, description, repoLabel);
    return {
      tool: "file_linear_issue",
      data: { summary: `Filed ${issue.identifier}: ${issue.title} — ${issue.url}` },
    };
  },

  get_issue_status: async (input, ctx) => {
    const denied = requireOwner(ctx);
    if (denied) return denied;

    const status = await fetchIssueStatus(input.issue_id as string);
    return {
      tool: "get_issue_status",
      data: {
        summary: `${status.identifier}: ${status.title}\nstate: ${status.state} | assignee: ${status.assignee} | updated: ${status.updatedAt.toISOString()}\n${status.url}`,
      },
    };
  },

  list_triaged_issues: async (input, ctx) => {
    const denied = requireOwner(ctx);
    if (denied) return denied;

    const repoLabel = input.repo_label as string | undefined;
    const state = input.state as string | undefined;
    const issues = await listTriageIssues(repoLabel, state);
    if (issues.length === 0) return { tool: "list_triaged_issues", data: { summary: "(no matching issues)" } };

    const lines = issues.map((i) => `${i.identifier} [${i.state}] ${i.title} — ${i.url}`);
    return { tool: "list_triaged_issues", data: { summary: lines.join("\n") } };
  },
};
