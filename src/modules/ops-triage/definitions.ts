import type { ChatCompletionTool } from "openai/resources/chat/completions";

// Owner-only tools for searching observability data and filing/tracking Linear issues.
// Gating happens at execution time (see executor.ts), not here — every guild that enables
// "ops-triage" advertises these tools to the model, but only the configured owner can
// actually run them.

export const OPS_TRIAGE_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_logs",
      description:
        "Search service logs (and traces, for services with tracing set up) in Grafana/Loki/Tempo over an explicit time range. Owner-only. To diagnose a specific reported message, use its t:<unix>:R timestamp from the conversation (pad +/- a few minutes) to set since/until — don't guess a range without one.",
      parameters: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description: "Start of the time range, ISO 8601 (e.g. 2026-08-28T10:00:00Z).",
          },
          until: {
            type: "string",
            description: "End of the time range, ISO 8601.",
          },
          service: {
            type: "string",
            description: "Which bot/service to search (e.g. sushii-bot, sushii-agent, sushii-sns). Omit to search across all services.",
          },
          query: {
            type: "string",
            description: "Free-text substring to filter log lines on (e.g. an error message or request ID). Omit to return all lines in the time range.",
          },
        },
        required: ["since", "until"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trace",
      description:
        "Fetch the full span tree for one trace by ID (from search_logs's trace list) — span names, durations, error status, and attributes/events, depth-indented. Use this to see exactly what happened inside a request, not just that a trace exists. Owner-only.",
      parameters: {
        type: "object",
        properties: {
          trace_id: { type: "string", description: "The Tempo trace ID, e.g. from a search_logs result line like \"trace:<id> [...]\"." },
        },
        required: ["trace_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_linear_issue",
      description:
        "File a Linear issue for a diagnosed bug or improvement, so it can be picked up by an implementation agent later. Owner-only.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short issue title." },
          description: { type: "string", description: "Full issue body — what's broken, root cause if known, and repro/evidence (message link, trace ID, log excerpt)." },
          repo_label: {
            type: "string",
            description: "Which repo this belongs to (e.g. sushii-bot, sushii-agent, sushii-sns, sushii-modmail) — used as the Linear label so an implementation agent can route it.",
          },
        },
        required: ["title", "description", "repo_label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_issue_status",
      description: "Look up a previously filed Linear issue's current status (state, assignee, last update) so you can check on progress. Owner-only.",
      parameters: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description: "The Linear issue identifier (e.g. ENG-123) or issue URL.",
          },
        },
        required: ["issue_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_triaged_issues",
      description: "List recently filed Linear issues, optionally filtered by repo and/or state, to get an overview of what's outstanding. Owner-only.",
      parameters: {
        type: "object",
        properties: {
          repo_label: {
            type: "string",
            description: "Filter to issues labeled for this repo (e.g. sushii-bot, sushii-agent). Omit to list across all repos.",
          },
          state: {
            type: "string",
            description: "Filter by workflow state (e.g. Todo, In Progress, Done, Canceled). Omit to list all open issues.",
          },
        },
      },
    },
  },
];
