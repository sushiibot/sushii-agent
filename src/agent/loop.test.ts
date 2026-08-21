import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, resolveToolEntries } from "./loop.ts";
import { BEHAVIOR_INSTRUCTIONS, buildAutoModPromptSection } from "../modules/moderation/prompt.ts";
import { AUTO_MOD_ONLY_TOOLS } from "../modules/moderation/tools.ts";
import { runTools } from "../modules/moderation/executor.ts";
import type { AutoModTriggerContext } from "./loop.ts";
import type { Client } from "discord.js";

function fakeClient(): Client<true> {
  return {} as unknown as Client<true>;
}

// Regression guard for the loop-seam extraction: BEHAVIOR_INSTRUCTIONS moved out of loop.ts
// into moderation/prompt.ts verbatim, and the autoModTrigger block moved from a hardcoded
// branch inside buildSystemPrompt to a module-supplied extraPromptSections entry. Both must
// produce byte-identical prompt content to before the refactor.
describe("buildSystemPrompt", () => {
  test("prepends the passed-in behaviorInstructions verbatim", () => {
    const prompt = buildSystemPrompt(BEHAVIOR_INSTRUCTIONS, {});
    expect(prompt.startsWith(BEHAVIOR_INSTRUCTIONS)).toBe(true);
  });

  test("is not hardcoded to moderation's instructions — a different module's text is honored", () => {
    const prompt = buildSystemPrompt("You are a wiki-sync assistant.", {});
    expect(prompt.startsWith("You are a wiki-sync assistant.")).toBe(true);
    expect(prompt).not.toContain("moderation intelligence assistant");
  });

  test("extraPromptSections appends module-supplied content (e.g. the auto-mod block) instead of the loop hardcoding it", () => {
    const trigger: AutoModTriggerContext = {
      reporterUserId: "1",
      reporterUsername: "reporter",
      incidentChannelId: "2",
      incidentChannelName: "general",
      triggerMessageContent: "@mods help",
      triggerMessageId: "3",
      modRoleId: "4",
      modImmuneRoleIds: [],
      newMemberThresholdDays: 3,
      anchorMessageId: "5",
    };
    const section = buildAutoModPromptSection(trigger);
    const prompt = buildSystemPrompt(BEHAVIOR_INSTRUCTIONS, { extraPromptSections: [section] });
    expect(prompt).toContain("AUTO-MOD MODE — AUTONOMOUS ENFORCEMENT");
    expect(prompt).toContain(section);

    const withoutTrigger = buildSystemPrompt(BEHAVIOR_INSTRUCTIONS, {});
    expect(withoutTrigger).not.toContain("AUTO-MOD MODE");
  });

  test("current-date note is always present", () => {
    const prompt = buildSystemPrompt(BEHAVIOR_INSTRUCTIONS, {});
    expect(prompt).toContain("Current date:");
  });
});

// Regression guard for the auto-mod gating seam: runAgentLoop computes toolEntries once via
// resolveToolEntries and feeds the same array to both buildAiTools (what the LLM is shown) and
// runTools (what can execute). If a future change let runTools resolve calls through a
// differently-filtered list than buildAiTools, an auto-mod-only enforcement tool (timeout_member,
// delete_user_messages, send_alert_message) could become callable outside auto-mod mode even
// though it's hidden from the model's tool list — this is the scenario these tests exercise
// end to end, not just at the list-filtering level.
describe("resolveToolEntries", () => {
  test("auto-mod-only tools are excluded from a moderation guild's entries outside auto-mod mode", () => {
    const names = new Set(resolveToolEntries(["moderation"], false).map((e) => e.name));
    for (const toolName of AUTO_MOD_ONLY_TOOLS) {
      expect(names.has(toolName)).toBe(false);
    }
  });

  test("auto-mod-only tools are included in a moderation guild's entries in auto-mod mode", () => {
    const names = new Set(resolveToolEntries(["moderation"], true).map((e) => e.name));
    for (const toolName of AUTO_MOD_ONLY_TOOLS) {
      expect(names.has(toolName)).toBe(true);
    }
  });

  test("runTools rejects a call to an auto-mod-only tool when resolveToolEntries ran outside auto-mod mode", async () => {
    const toolEntries = resolveToolEntries(["moderation"], false);

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

  test("runTools executes an auto-mod-only tool when resolveToolEntries ran in auto-mod mode", async () => {
    const toolEntries = resolveToolEntries(["moderation"], true);

    const result = await runTools(
      [{ toolCallId: "1", toolName: "timeout_member", input: { user_id: "1", duration_ms: 60000 } }],
      "guild1",
      fakeClient(),
      toolEntries,
    );

    const part = result.toolMessage.content[0];
    expect(part.type).toBe("tool-result");
    if (part.type === "tool-result" && part.output.type === "text") {
      // Pinned to the exact string timeoutMember's handler returns for an unconfigured guild —
      // proves dispatch actually reached the handler rather than stopping at "Unknown tool"
      // (config.guildConfig has no entry for "guild1" in this test).
      expect(part.output.value).toBe("Guild not configured");
    } else {
      throw new Error("expected a text tool-result part");
    }
  });
});
