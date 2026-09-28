import { describe, expect, test } from "bun:test";
import { formatStamp, lastUserStamp, parseStamp, stampUserText, stripStamp } from "./turnStamp.ts";

const at = new Date(Date.UTC(2026, 8, 27, 14, 40));

describe("turnStamp", () => {
  test("formats UTC in 12-hour time with weekday and full date", () => {
    expect(formatStamp(at)).toBe("Sun 2026-09-27 2:40 PM UTC");
    expect(formatStamp(new Date(Date.UTC(2026, 0, 5, 0, 7)))).toBe("Mon 2026-01-05 12:07 AM UTC");
    expect(formatStamp(new Date(Date.UTC(2026, 0, 5, 12, 0)))).toBe("Mon 2026-01-05 12:00 PM UTC");
  });

  test("no gap note for the first message or a short gap", () => {
    expect(stampUserText("hi", at, undefined)).toBe("[Sun 2026-09-27 2:40 PM UTC] hi");
    const fiveHoursAgo = new Date(at.getTime() - 5 * 3600_000);
    expect(stampUserText("hi", at, fiveHoursAgo)).toBe("[Sun 2026-09-27 2:40 PM UTC] hi");
  });

  test("gap note in hours, then days", () => {
    expect(stampUserText("hi", at, new Date(at.getTime() - 7 * 3600_000))).toBe("[Sun 2026-09-27 2:40 PM UTC · 7 hours later] hi");
    expect(stampUserText("hi", at, new Date(at.getTime() - 3 * 86400_000))).toBe("[Sun 2026-09-27 2:40 PM UTC · 3 days later] hi");
    expect(stampUserText("hi", at, new Date(at.getTime() - 26 * 3600_000))).toBe("[Sun 2026-09-27 2:40 PM UTC · 1 day later] hi");
    expect(stampUserText("hi", at, new Date(at.getTime() - 23.6 * 3600_000))).toBe("[Sun 2026-09-27 2:40 PM UTC · 1 day later] hi");
  });

  test("parseStamp round-trips with and without a gap note, and ignores unstamped text", () => {
    for (const d of [at, new Date(Date.UTC(2026, 0, 5, 0, 7)), new Date(Date.UTC(2026, 0, 5, 12, 0))]) {
      expect(parseStamp(stampUserText("x", d, undefined))?.getTime()).toBe(d.getTime());
    }
    expect(parseStamp("[Sun 2026-09-27 2:40 PM UTC · 3 days later] x")?.getTime()).toBe(at.getTime());
    expect(parseStamp("hello [Sun 2026-09-27 2:40 PM UTC] x")).toBeUndefined();
    expect(parseStamp("plain")).toBeUndefined();
  });

  test("lastUserStamp finds the newest stamped user message, skipping others", () => {
    const older = new Date(Date.UTC(2026, 8, 20, 9, 0));
    expect(
      lastUserStamp([
        { role: "user", content: stampUserText("a", older, undefined) },
        { role: "assistant", content: "[Sun 2026-09-27 2:40 PM UTC] echoed" },
        { role: "user", content: "unstamped legacy message" },
      ])?.getTime(),
    ).toBe(older.getTime());
    expect(lastUserStamp([{ role: "user", content: "legacy" }])).toBeUndefined();
  });

  test("stripStamp removes only a leading stamp", () => {
    expect(stripStamp("[Sun 2026-09-27 2:40 PM UTC · 3 days later] ok")).toBe("ok");
    expect(stripStamp("ok [Sun 2026-09-27 2:40 PM UTC] x")).toBe("ok [Sun 2026-09-27 2:40 PM UTC] x");
  });
});
