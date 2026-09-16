// ToolRegistry impl (contracts.ts §7). Phase-A scope: filter by hosts-present + capabilities
// only — the full A/B/C category × capability gating matrix is deferred to U6.
import type { SurfaceId, ToolEntry, ToolHosts, ToolRegistry, SurfaceSession } from "../contracts.ts";
import "./hosts.ts";
import { MESSAGE_CACHE_TOOL_ENTRIES } from "./messageCache/tools.ts";
import { PORTABLE_TOOL_ENTRIES } from "./portable/tools.ts";
import { MCP_TOOL_ENTRIES } from "./mcp/tools.ts";
import { OPS_TRIAGE_TOOL_ENTRIES } from "./opsTriage/tools.ts";
import { DISCORD_TOOL_ENTRIES } from "./discord/tools.ts";
import { deleteUserMessagesEntry } from "./discord/deleteUserMessages.ts";

export const ALL_TOOL_ENTRIES: ToolEntry<keyof ToolHosts>[] = [
  ...MESSAGE_CACHE_TOOL_ENTRIES,
  ...PORTABLE_TOOL_ENTRIES,
  ...MCP_TOOL_ENTRIES,
  ...OPS_TRIAGE_TOOL_ENTRIES,
  ...DISCORD_TOOL_ENTRIES,
  deleteUserMessagesEntry,
];

function hostsSatisfied(entry: ToolEntry<keyof ToolHosts>, hosts: ToolHosts): boolean {
  return entry.requiresHosts.every((h) => hosts[h] !== undefined);
}

function capabilitiesSatisfied(entry: ToolEntry<keyof ToolHosts>, session: SurfaceSession): boolean {
  return (entry.requiresCapabilities ?? []).every((c) => session.capabilities[c]);
}

export class CoreToolRegistry implements ToolRegistry {
  constructor(private readonly entries: ToolEntry<keyof ToolHosts>[] = ALL_TOOL_ENTRIES) {}

  resolve(session: SurfaceSession, _space: { surface: SurfaceId; spaceId: string }): ToolEntry<keyof ToolHosts>[] {
    return this.entries.filter((entry) => hostsSatisfied(entry, session.hosts) && capabilitiesSatisfied(entry, session));
  }
}

export function createToolRegistry(entries?: ToolEntry<keyof ToolHosts>[]): ToolRegistry {
  return new CoreToolRegistry(entries);
}
