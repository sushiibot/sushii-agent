import { describe, expect, test } from "bun:test";
import { isTruncatedHeadOf } from "./liveTask.ts";

describe("isTruncatedHeadOf (settle de-dup of the final message)", () => {
  test("matches a 400-char-truncated head against the full summary", () => {
    const full = "Agent responses are split into multiple Discord messages, not sent as files.";
    const truncated = full.slice(0, 40) + "…";
    expect(isTruncatedHeadOf(truncated, full)).toBe(true);
  });

  test("matches when identical (short final message, no truncation)", () => {
    expect(isTruncatedHeadOf("Done — nothing needed changing.", "Done — nothing needed changing.")).toBe(true);
  });

  test("tolerates collapsed whitespace/newlines between tail and summary", () => {
    expect(isTruncatedHeadOf("Fixed the bug\nin a.ts…", "Fixed the bug in a.ts and added a test.")).toBe(true);
  });

  test("does not match unrelated lines", () => {
    expect(isTruncatedHeadOf("Reading the config…", "Fixed the bug in a.ts.")).toBe(false);
  });

  test("ignores trivially short heads to avoid false positives", () => {
    expect(isTruncatedHeadOf("Ok…", "Ok, I finished everything you asked for.")).toBe(false);
  });
});
