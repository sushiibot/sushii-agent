// Owner-only observability/triage tools. Grafana/Loki/Tempo and Linear are plain HTTP — no
// discord.js, no host needed. Owner-gating is a RUNTIME check on ctx.owner (BRIEF), not a
// registry-level filter.
import type { ToolEntry, ToolContext } from "../../contracts.ts";
import { config } from "../../../config.ts";
import { queryLoki, queryTempo, getTraceById } from "../../../modules/ops-triage/grafana.ts";
import { createTriageIssue, fetchIssueStatus, listTriageIssues } from "../../../modules/ops-triage/linear.ts";

function requireOwner(ctx: ToolContext): string | undefined {
  if (!config.ownerDiscordId) return "ops-triage is not configured (OWNER_DISCORD_ID unset).";
  if (ctx.owner?.userId !== config.ownerDiscordId) return "This tool is owner-only.";
  return undefined;
}

export const searchLogsEntry: ToolEntry = {
  name: "search_logs",
  definition: {
    name: "search_logs",
    description: "Search service logs (and traces) in Grafana/Loki/Tempo over an explicit time range. Owner-only.",
    parameters: {
      type: "object",
      properties: {
        since: { type: "string", description: "Start of the time range, ISO 8601." },
        until: { type: "string", description: "End of the time range, ISO 8601." },
        service: { type: "string", description: "Which bot/service to search. Omit to search all." },
        query: { type: "string", description: "Free-text substring to filter log lines on." },
      },
      required: ["since", "until"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const denied = requireOwner(ctx);
    if (denied) return { content: denied };

    const since = input.since as string;
    const until = input.until as string;
    const service = input.service as string | undefined;
    const query = input.query as string | undefined;
    const startMs = Date.parse(since);
    const endMs = Date.parse(until);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { content: "since/until must be valid ISO 8601 timestamps." };

    const logs = await queryLoki({ service, query, startMs, endMs });
    const parts = [`Logs ${since} to ${until}${service ? ` (${service})` : ""}:`, logs];
    try {
      const traces = await queryTempo(service, startMs, endMs);
      if (traces) parts.push("", "Traces:", traces);
    } catch (err) {
      parts.push("", `(trace lookup failed: ${err instanceof Error ? err.message : String(err)})`);
    }
    return { content: parts.join("\n") };
  },
};

export const getTraceEntry: ToolEntry = {
  name: "get_trace",
  definition: {
    name: "get_trace",
    description: "Fetch the full span tree for one trace by ID. Owner-only.",
    parameters: {
      type: "object",
      properties: { trace_id: { type: "string", description: "The Tempo trace ID." } },
      required: ["trace_id"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const denied = requireOwner(ctx);
    if (denied) return { content: denied };
    const traceId = input.trace_id as string;
    const spans = await getTraceById(traceId);
    return { content: `Trace ${traceId}:\n${spans}` };
  },
};

export const fileLinearIssueEntry: ToolEntry = {
  name: "file_linear_issue",
  definition: {
    name: "file_linear_issue",
    description: "File a Linear issue for a diagnosed bug or improvement. Owner-only.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short issue title." },
        description: { type: "string", description: "Full issue body." },
        repo_label: { type: "string", description: "Which repo this belongs to." },
      },
      required: ["title", "description", "repo_label"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const denied = requireOwner(ctx);
    if (denied) return { content: denied };
    const issue = await createTriageIssue(input.title as string, input.description as string, input.repo_label as string);
    return { content: `Filed ${issue.identifier}: ${issue.title} — ${issue.url}` };
  },
};

export const getIssueStatusEntry: ToolEntry = {
  name: "get_issue_status",
  definition: {
    name: "get_issue_status",
    description: "Look up a previously filed Linear issue's current status. Owner-only.",
    parameters: {
      type: "object",
      properties: { issue_id: { type: "string", description: "The Linear issue identifier or URL." } },
      required: ["issue_id"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const denied = requireOwner(ctx);
    if (denied) return { content: denied };
    const status = await fetchIssueStatus(input.issue_id as string);
    return { content: `${status.identifier}: ${status.title}\nstate: ${status.state} | assignee: ${status.assignee} | updated: ${status.updatedAt.toISOString()}\n${status.url}` };
  },
};

export const listTriagedIssuesEntry: ToolEntry = {
  name: "list_triaged_issues",
  definition: {
    name: "list_triaged_issues",
    description: "List recently filed Linear issues, optionally filtered by repo and/or state. Owner-only.",
    parameters: {
      type: "object",
      properties: {
        repo_label: { type: "string", description: "Filter to issues labeled for this repo." },
        state: { type: "string", description: "Filter by workflow state." },
      },
      required: [],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const denied = requireOwner(ctx);
    if (denied) return { content: denied };
    const issues = await listTriageIssues(input.repo_label as string | undefined, input.state as string | undefined);
    if (issues.length === 0) return { content: "(no matching issues)" };
    return { content: issues.map((i) => `${i.identifier} [${i.state}] ${i.title} — ${i.url}`).join("\n") };
  },
};

export const OPS_TRIAGE_TOOL_ENTRIES: ToolEntry[] = [searchLogsEntry, getTraceEntry, fileLinearIssueEntry, getIssueStatusEntry, listTriagedIssuesEntry];
