import type { ToolEntry, ToolContext } from "../registry.ts";
import { MODERATION_TOOL_DEFINITIONS } from "./definitions.ts";
import { MODERATION_DISPATCH } from "./executor.ts";

/** Tools only exposed when the loop is running in auto-mod (autonomous enforcement) mode. */
export const AUTO_MOD_ONLY_TOOLS = new Set(["timeout_member", "delete_user_messages", "send_alert_message"]);

/** Tools that require an Exa API key to function. */
export const EXA_TOOLS = new Set(["web_search", "fetch_url_content"]);

export const MODERATION_TOOL_ENTRIES: ToolEntry[] = MODERATION_TOOL_DEFINITIONS.map((definition) => {
  const name = definition.function.name;
  const handler = MODERATION_DISPATCH[name];
  if (!handler) throw new Error(`No MODERATION_DISPATCH entry for declared tool "${name}"`);
  return {
    name,
    definition,
    execute: (input: Record<string, unknown>, ctx: ToolContext) => handler(input, ctx),
  };
});
