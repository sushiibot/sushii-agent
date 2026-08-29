import type { ToolEntry } from "../registry.ts";
import { OPS_TRIAGE_TOOL_DEFINITIONS } from "./definitions.ts";
import { OPS_TRIAGE_DISPATCH } from "./executor.ts";

export const OPS_TRIAGE_TOOL_ENTRIES: ToolEntry[] = OPS_TRIAGE_TOOL_DEFINITIONS.map((definition) => {
  const name = definition.function.name;
  const handler = OPS_TRIAGE_DISPATCH[name];
  if (!handler) throw new Error(`No OPS_TRIAGE_DISPATCH entry for declared tool "${name}"`);
  return { name, definition, execute: handler };
});
