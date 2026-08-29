import type { ToolEntry } from "../registry.ts";
import { OPS_TRIAGE_TOOL_DEFINITIONS } from "./definitions.ts";
import { OPS_TRIAGE_DISPATCH } from "./executor.ts";

/** Tools that require GRAFANA_BASE_URL (and TEMPO_BASE_URL for get_trace, falls back to grafanaBaseUrl) to function. */
export const GRAFANA_TOOLS = new Set(["search_logs", "get_trace"]);

/** Tools that require LINEAR_API_KEY (and LINEAR_TEAM_ID for file_linear_issue/list_triaged_issues) to function. */
export const LINEAR_TOOLS = new Set(["file_linear_issue", "get_issue_status", "list_triaged_issues"]);

export const OPS_TRIAGE_TOOL_ENTRIES: ToolEntry[] = OPS_TRIAGE_TOOL_DEFINITIONS.map((definition) => {
  const name = definition.function.name;
  const handler = OPS_TRIAGE_DISPATCH[name];
  if (!handler) throw new Error(`No OPS_TRIAGE_DISPATCH entry for declared tool "${name}"`);
  return { name, definition, execute: handler };
});
