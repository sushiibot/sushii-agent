// ToolRegistry impl (contracts.ts §7). Filters by hosts-present + capabilities, then by the
// same config/mode gates the pre-multi-surface resolveToolEntries (src/agent/loop.ts) applied —
// the A/B/C surface-category matrix beyond that is deferred to U6.
import type { SurfaceId, ToolEntry, ToolHosts, ToolRegistry, SurfaceSession } from "../contracts.ts";
import { config } from "../../config.ts";
import "./hosts.ts";
import { MESSAGE_CACHE_TOOL_ENTRIES } from "./messageCache/tools.ts";
import { PORTABLE_TOOL_ENTRIES } from "./portable/tools.ts";
import { MCP_TOOL_ENTRIES } from "./mcp/tools.ts";
import { OPS_TRIAGE_TOOL_ENTRIES } from "./opsTriage/tools.ts";
import { DISCORD_TOOL_ENTRIES } from "./discord/tools.ts";
import { deleteUserMessagesEntry } from "./discord/deleteUserMessages.ts";
import { WIKI_TOOL_ENTRIES } from "./wiki/tools.ts";

export const ALL_TOOL_ENTRIES: ToolEntry<keyof ToolHosts>[] = [
  ...MESSAGE_CACHE_TOOL_ENTRIES,
  ...PORTABLE_TOOL_ENTRIES,
  ...MCP_TOOL_ENTRIES,
  ...OPS_TRIAGE_TOOL_ENTRIES,
  ...DISCORD_TOOL_ENTRIES,
  ...WIKI_TOOL_ENTRIES,
  deleteUserMessagesEntry,
];

/** Restricted to the autonomous auto-mod driver — a conversational request must never see these. */
const AUTO_MOD_ONLY_TOOLS = new Set(["timeout_member", "delete_user_messages", "send_alert_message"]);
const EXA_TOOLS = new Set(["web_search", "fetch_url_content"]);
const GRAFANA_TOOLS = new Set(["search_logs", "get_trace"]);
const LINEAR_TOOLS = new Set(["file_linear_issue", "get_issue_status", "list_triaged_issues"]);

/** Config-key gates, resolved once per `resolve()` call rather than baked into the class — lets
 *  a caller (tests, U4's wiring) supply availability directly instead of the registry reaching
 *  into the global `config` singleton itself. */
export interface ToolAvailability {
  exa: boolean;
  owner: boolean;
  grafanaBaseUrl: boolean;
  linear: boolean;
}

function defaultAvailability(): ToolAvailability {
  return {
    exa: !!config.exaApiKey,
    owner: !!config.ownerDiscordId,
    grafanaBaseUrl: !!config.grafanaBaseUrl,
    linear: !!(config.linearApiKey && config.linearTeamId),
  };
}

function hostsSatisfied(entry: ToolEntry<keyof ToolHosts>, hosts: ToolHosts): boolean {
  return entry.requiresHosts.every((h) => hosts[h] !== undefined);
}

function capabilitiesSatisfied(entry: ToolEntry<keyof ToolHosts>, session: SurfaceSession): boolean {
  return (entry.requiresCapabilities ?? []).every((c) => session.capabilities[c]);
}

export class CoreToolRegistry implements ToolRegistry {
  constructor(
    private readonly entries: ToolEntry<keyof ToolHosts>[] = ALL_TOOL_ENTRIES,
    private readonly availability: () => ToolAvailability = defaultAvailability,
  ) {}

  resolve(session: SurfaceSession, space: { surface: SurfaceId; spaceId: string; autoMod?: boolean }): ToolEntry<keyof ToolHosts>[] {
    const autoMod = space.autoMod ?? false;
    const a = this.availability();
    return this.entries
      .filter((entry) => hostsSatisfied(entry, session.hosts) && capabilitiesSatisfied(entry, session))
      .filter((entry) => autoMod || !AUTO_MOD_ONLY_TOOLS.has(entry.name))
      .filter((entry) => a.exa || !EXA_TOOLS.has(entry.name))
      .filter((entry) => a.owner || !(GRAFANA_TOOLS.has(entry.name) || LINEAR_TOOLS.has(entry.name)))
      .filter((entry) => a.grafanaBaseUrl || !GRAFANA_TOOLS.has(entry.name))
      .filter((entry) => a.linear || !LINEAR_TOOLS.has(entry.name));
  }
}

export function createToolRegistry(entries?: ToolEntry<keyof ToolHosts>[], availability?: () => ToolAvailability): ToolRegistry {
  return new CoreToolRegistry(entries, availability);
}
