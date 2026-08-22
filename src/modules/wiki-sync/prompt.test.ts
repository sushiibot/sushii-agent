import { describe, expect, test } from "bun:test";
import { buildSweepTriggerPrompt } from "./prompt.ts";

describe("buildSweepTriggerPrompt", () => {
  test("lists every message batch file path", () => {
    const prompt = buildSweepTriggerPrompt(["/data/wiki-sync/inbox/g1/general-1.md", "/data/wiki-sync/inbox/g1/support-2.md"]);
    expect(prompt).toContain("/data/wiki-sync/inbox/g1/general-1.md");
    expect(prompt).toContain("/data/wiki-sync/inbox/g1/support-2.md");
  });

  test("mentions reading the files and updating the wiki", () => {
    const prompt = buildSweepTriggerPrompt(["/data/wiki-sync/inbox/g1/general-1.md"]);
    expect(prompt.toLowerCase()).toContain("read them");
    expect(prompt.toLowerCase()).toContain("wiki");
  });
});
