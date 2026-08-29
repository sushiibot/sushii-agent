import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { runTools, MODERATION_DISPATCH } from "./executor.ts";
import { buildToolsForGuild } from "../registry.ts";
import { MODERATION_TOOL_ENTRIES } from "./tools.ts";

// runTools no longer takes a client that actually needs to do anything — every tool exercised
// below (ask_question, search_messages) ignores it, so a bare cast stands in for a real one.
function fakeClient(): Client<true> {
  return {} as unknown as Client<true>;
}

// Regression guard for the executor/registry dispatch-wiring fix: runTools must resolve calls
// through the `toolEntries` a guild's enabled modules actually built (buildToolsForGuild), not
// through the module-level MODERATION_DISPATCH table, which is unscoped by enabledModules and
// contains every tool name regardless of which modules are on.
describe("runTools dispatch", () => {
  test("a tool call for a guild with moderation enabled resolves and executes through buildToolsForGuild's ToolEntry.execute", async () => {
    const toolEntries = buildToolsForGuild(["moderation"]);

    const result = await runTools(
      [{ toolCallId: "1", toolName: "ask_question", input: { question: "Ban this user?", choices: ["Yes", "No"] } }],
      "guild1",
      fakeClient(),
      toolEntries,
    );

    // ask_question only reaches this pendingQuestion/output shape by actually running through
    // ToolEntry.execute — "Unknown tool" would leave pendingQuestion unset entirely.
    expect(result.pendingQuestion).toEqual({ question: "Ban this user?", choices: ["Yes", "No"] });
    const part = result.toolMessage.content[0];
    expect(part.type).toBe("tool-result");
    if (part.type === "tool-result" && part.output.type === "text") {
      expect(part.output.value).toContain("Question sent to moderator");
    } else {
      throw new Error("expected a text tool-result part");
    }
  });

  test("a moderation tool name is unroutable for a guild that doesn't have moderation enabled, even though MODERATION_DISPATCH has a handler for it", async () => {
    // No "moderation" in enabledModules — buildToolsForGuild always folds in "mcp" (empty
    // until populateMcpToolEntries() runs at startup) and "ops-triage" (owner-scoped, not
    // guild-scoped — always present), but neither contributes a "search_messages" entry, so
    // that name specifically stays unroutable regardless.
    const toolEntries = buildToolsForGuild([]);
    expect(toolEntries.some((e) => e.name === "search_messages")).toBe(false);
    expect(MODERATION_DISPATCH.search_messages).toBeDefined();

    const result = await runTools(
      [{ toolCallId: "1", toolName: "search_messages", input: { query: "test" } }],
      "guild1",
      fakeClient(),
      toolEntries,
    );

    const part = result.toolMessage.content[0];
    expect(part.type).toBe("tool-result");
    if (part.type === "tool-result" && part.output.type === "text") {
      expect(part.output.value).toBe("Unknown tool: search_messages");
    } else {
      throw new Error("expected a text tool-result part");
    }
  });

  test("a tool absent from a populated toolEntries list (not just an empty one) is unroutable", async () => {
    // A realistic operational case, not the degenerate empty-list one: moderation is enabled
    // (so toolEntries is populated with real entries), but one tool is missing from it — here
    // hand-filtered to isolate this from resolveToolEntries's own auto-mod gating, which
    // src/agent/loop.test.ts's resolveToolEntries suite covers directly against the real
    // filtered list. Confirms a populated-but-incomplete toolEntries still renders a name
    // unroutable, not merely absent from what the LLM was shown.
    const toolEntries = buildToolsForGuild(["moderation"]).filter((e) => e.name !== "timeout_member");
    expect(toolEntries.length).toBeGreaterThan(0);

    const result = await runTools(
      [{ toolCallId: "1", toolName: "timeout_member", input: { user_id: "1", duration_ms: 60000 } }],
      "guild1",
      fakeClient(),
      toolEntries,
    );

    const part = result.toolMessage.content[0];
    expect(part.type).toBe("tool-result");
    if (part.type === "tool-result" && part.output.type === "text") {
      expect(part.output.value).toBe("Unknown tool: timeout_member");
    } else {
      throw new Error("expected a text tool-result part");
    }
  });

  test("runTools dispatches strictly through the toolEntries argument, never falling back to MODERATION_DISPATCH directly", async () => {
    // A name MODERATION_DISPATCH definitely has a handler for, but toolEntries (what a guild's
    // enabled modules actually resolved to) doesn't carry it — this is the exact bug: the old
    // executeSingleTool looked names up in MODERATION_DISPATCH directly, ignoring toolEntries.
    expect(MODERATION_DISPATCH.ask_question).toBeDefined();

    const result = await runTools(
      [{ toolCallId: "1", toolName: "ask_question", input: { question: "q", choices: [] } }],
      "guild1",
      fakeClient(),
      [],
    );

    expect(result.pendingQuestion).toBeUndefined();
    const part = result.toolMessage.content[0];
    expect(part.type).toBe("tool-result");
    if (part.type === "tool-result" && part.output.type === "text") {
      expect(part.output.value).toBe("Unknown tool: ask_question");
    } else {
      throw new Error("expected a text tool-result part");
    }
  });
});

// MODERATION_DISPATCH itself wasn't removed by the fix — it's kept as the single source of
// handler implementations that MODERATION_TOOL_ENTRIES (tools.ts) wraps into ToolEntry.execute,
// and that populateMcpToolEntries (registry.ts) uses to route MCP-advertised tool names that
// happen to match a moderation handler. What changed is that runTools no longer reads it
// directly — it only reaches a handler via a ToolEntry built from it.
describe("MODERATION_DISPATCH", () => {
  test("every MODERATION_TOOL_ENTRIES name has a corresponding MODERATION_DISPATCH handler backing its execute", () => {
    for (const entry of MODERATION_TOOL_ENTRIES) {
      expect(MODERATION_DISPATCH[entry.name]).toBeDefined();
    }
  });

  test("MODERATION_TOOL_ENTRIES names are each declared exactly once, with no duplicates", () => {
    // MODERATION_DISPATCH is a strict superset here: get_user_mod_history / get_user_cross_server_bans /
    // get_guild_recent_cases are routed only via populateMcpToolEntries (MCP-advertised names), never
    // declared in MODERATION_TOOL_DEFINITIONS, so they're absent from MODERATION_TOOL_ENTRIES on purpose.
    const entryNames = MODERATION_TOOL_ENTRIES.map((e) => e.name);
    const dispatchNames = new Set(Object.keys(MODERATION_DISPATCH));
    for (const name of entryNames) expect(dispatchNames.has(name)).toBe(true);
    expect(entryNames.length).toBe(new Set(entryNames).size);
  });
});
