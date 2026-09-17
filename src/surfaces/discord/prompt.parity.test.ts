import { describe, expect, test } from "bun:test";
import { assembleSystemPrompt } from "../../core/systemPrompt.ts";
import { OWNER_CASE, PROMPT_CASES, normalizeDate } from "./__fixtures__/systemPromptCases.ts";
import golden from "./__fixtures__/systemPrompt.golden.json" with { type: "json" };

// Golden parity for the core system-prompt assembly. The fixtures were captured from the
// pre-multi-surface buildSystemPrompt (src/agent/loop.ts); prompt.oracle.test.ts proves they stay
// faithful to it while both exist. This file must keep passing after the old builder is deleted.
describe("assembleSystemPrompt golden parity", () => {
  for (const [name, expected] of Object.entries(golden as Record<string, string>)) {
    test(name, () => {
      expect(normalizeDate(assembleSystemPrompt(PROMPT_CASES[name]))).toBe(expected);
    });
  }

  // Ops-triage (owner-only) block must sit immediately after the triggering-user section and
  // before Server Context — the position the old prompt emitted it from. Tested structurally
  // because the old builder gated it on live config a byte golden can't reproduce.
  test("owner section is positioned after triggeringUser, before serverContext", () => {
    const parts = assembleSystemPrompt(OWNER_CASE).split("\n\n---\n\n");
    const userIdx = parts.findIndex((p) => p.startsWith("Request from:"));
    const ownerIdx = parts.indexOf(OWNER_CASE.ownerSection!);
    const serverIdx = parts.findIndex((p) => p.startsWith("## Server Context"));
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(ownerIdx).toBe(userIdx + 1);
    expect(serverIdx).toBe(ownerIdx + 1);
  });
});
