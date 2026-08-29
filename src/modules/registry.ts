import type { Client } from "discord.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { MODERATION_DISPATCH, type ToolResult, type ModerationToolContext } from "./moderation/executor.ts";
import { MODERATION_TOOL_ENTRIES } from "./moderation/tools.ts";
import { wikiSyncModule } from "./wiki-sync/index.ts";
import { OPS_TRIAGE_TOOL_ENTRIES } from "./ops-triage/tools.ts";

export type ModuleId = "moderation" | "wiki-sync" | "mcp" | "ops-triage";

export interface ToolContext {
  guildId: string;
  client: Client<true>;
  autoModTrigger?: ModerationToolContext["autoModTrigger"];
  /** Discord user ID of whoever triggered this loop turn. Owner-gated tools (ops-triage) must check this themselves at execution time — it's not enforced by list-assembly. */
  triggeringUserId?: string;
}

export interface ToolEntry {
  name: string;
  definition: ChatCompletionTool;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Plugs into the shared runAgentLoop engine (moderation, mcp) — contributes tools + a prompt fragment. */
export interface LoopModuleDefinition {
  kind: "loop";
  id: ModuleId;
  toolEntries: ToolEntry[];
}

/**
 * Owns its own execution engine end-to-end (wiki-sync, via Pi's createAgentSession —
 * see docs/wiki or the module's own README once built). Still a module in every other
 * sense — own folder, own index.ts, gated by the same enabledModules config — it just
 * doesn't route through buildToolsForGuild/runAgentLoop.
 */
export interface StandaloneModuleDefinition {
  kind: "standalone";
  id: ModuleId;
  run: (ctx: { guildId: string; client: Client<true> }) => Promise<void>;
}

export type ModuleDefinition = LoopModuleDefinition | StandaloneModuleDefinition;

const moderationModule: LoopModuleDefinition = {
  kind: "loop",
  id: "moderation",
  toolEntries: MODERATION_TOOL_ENTRIES,
};

/**
 * MCP tools are fetched from the sushii-mcp server at runtime (after a handshake in
 * startBot()), so this can't be a static array like moderation's — toolEntries starts
 * empty and startBot() populates it in place once the handshake completes. Every guild
 * with any module enabled still gets MCP tools (matches the pre-refactor global-push
 * behavior); no per-guild MCP scoping in this phase.
 */
const mcpModule: LoopModuleDefinition = {
  kind: "loop",
  id: "mcp",
  toolEntries: [],
};

/**
 * Owner-only tools (log/trace search, file/track Linear issues) for triaging bugs across
 * sushii's whole bot suite, not any one guild's moderation setup -- so unlike moderation/
 * wiki-sync, this is always included regardless of `enabledModules` (same as mcp), rather
 * than needing per-guild opt-in. The actual security boundary is elsewhere: resolveToolEntries
 * (agent/loop.ts) hides these tools from the model entirely unless OWNER_DISCORD_ID and the
 * relevant service credentials are configured, and each tool's own triggeringUserId check
 * (ops-triage/executor.ts) enforces it again at execution time.
 */
const opsTriageModule: LoopModuleDefinition = {
  kind: "loop",
  id: "ops-triage",
  toolEntries: OPS_TRIAGE_TOOL_ENTRIES,
};

export const MODULES: Record<ModuleId, ModuleDefinition> = {
  moderation: moderationModule,
  "wiki-sync": wikiSyncModule,
  mcp: mcpModule,
  "ops-triage": opsTriageModule,
};

/**
 * Called once at startup (bot.ts startBot()) after the MCP handshake completes.
 * Preserves the pre-refactor dispatch behavior exactly: a fetched MCP tool whose name
 * matches an existing MODERATION_DISPATCH entry (get_user_mod_history, etc. — the
 * SushiiMcpClient methods with their own hardcoded RPC calls) routes there; any other
 * name the server happens to advertise was "Unknown tool" before this refactor too
 * (the old switch had no generic MCP-forwarding case) and stays that way.
 */
export function populateMcpToolEntries(definitions: ChatCompletionTool[]): void {
  mcpModule.toolEntries = definitions.map((definition) => {
    const name = definition.function.name;
    const handler = MODERATION_DISPATCH[name];
    return {
      name,
      definition,
      execute: handler ?? (async () => ({ tool: "error", message: `Unknown tool: ${name}` })),
    } satisfies ToolEntry;
  });
}

/**
 * Every ToolEntry contributed by this guild's enabled loop-based modules. Standalone
 * modules (wiki-sync) never contribute — they don't route through the shared loop.
 *
 * MCP and ops-triage tools are always included regardless of `enabledModules` — MCP matches
 * the pre-refactor behavior where TOOL_DEFINITIONS.push(...mcpTools) made them globally
 * available to every guild (per-guild MCP scoping is out of scope for this refactor);
 * ops-triage is owner-scoped rather than guild-scoped, see its comment above.
 */
export function buildToolsForGuild(enabledModules: ModuleId[]): ToolEntry[] {
  const ids = new Set<ModuleId>([...enabledModules, "mcp", "ops-triage"]);
  return [...ids]
    .map((id) => MODULES[id])
    .filter((m): m is LoopModuleDefinition => m.kind === "loop")
    .flatMap((m) => m.toolEntries);
}
