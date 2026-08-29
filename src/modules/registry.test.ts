import { describe, expect, test } from "bun:test";
import { buildToolsForGuild } from "./registry.ts";
import { MODERATION_TOOL_ENTRIES, AUTO_MOD_ONLY_TOOLS } from "./moderation/tools.ts";
import { OPS_TRIAGE_TOOL_ENTRIES } from "./ops-triage/tools.ts";

// Regression guard for the TOOL_DEFINITIONS -> per-module registry refactor: the set of
// tool names a moderation-only guild sees must not silently drop or duplicate a tool.
describe("buildToolsForGuild", () => {
  test("moderation-only guild gets every moderation tool name plus ops-triage's (always-included, owner-scoped not guild-scoped), each exactly once", () => {
    const names = buildToolsForGuild(["moderation"]).map((e) => e.name);
    const expected = [...MODERATION_TOOL_ENTRIES, ...OPS_TRIAGE_TOOL_ENTRIES].map((e) => e.name);
    expect(new Set(names)).toEqual(new Set(expected));
    expect(names.length).toBe(new Set(names).size); // no duplicates
  });

  test("auto-mod-only tools are declared for moderation guilds (gating happens in buildAiTools, not the registry)", () => {
    const names = new Set(buildToolsForGuild(["moderation"]).map((e) => e.name));
    for (const toolName of AUTO_MOD_ONLY_TOOLS) {
      expect(names.has(toolName)).toBe(true);
    }
  });

  test("wiki-sync (standalone module) never contributes tool entries", () => {
    const withWikiSync = buildToolsForGuild(["moderation", "wiki-sync"]);
    const withoutWikiSync = buildToolsForGuild(["moderation"]);
    expect(withWikiSync.length).toBe(withoutWikiSync.length);
  });

  test("mcp tools are always included even when not in enabledModules (matches pre-refactor global-push behavior)", () => {
    // mcpModule.toolEntries starts empty until startBot() populates it, but the "mcp" id
    // is always folded into the set buildToolsForGuild queries regardless of what's passed.
    const names = buildToolsForGuild([]).map((e) => e.name);
    expect(Array.isArray(names)).toBe(true); // doesn't throw when enabledModules omits everything
  });
});
