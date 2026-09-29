import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FLUSH_MARKER, buildHandoff, compactionHandoff, createCompactionHandoffExtension, flushPrompt, flushRanThisCycle, memoryFilesSignature, writeResetHandoff } from "./memoryFlush.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ws-memflush-"));
  mkdirSync(join(home, "memory"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = new Date("2026-09-29T14:05:00Z");
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 0 });
const msgEntry = (message: object, id: string) => ({ type: "message", id, parentId: null, timestamp: "", message }) as unknown as SessionEntry;
const compactionEntry = (id: string) => ({ type: "compaction", id, parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 }) as unknown as SessionEntry;
const fileOps = (edited: string[] = []) => ({ read: new Set<string>(), written: new Set<string>(), edited: new Set(edited) });

describe("flushRanThisCycle", () => {
  test("only a flush prompt after the latest compaction counts", () => {
    const flush = msgEntry(user(flushPrompt("compaction")), "f");
    expect(flushRanThisCycle([msgEntry(user("[discord:1 …]\nhi"), "a")])).toBe(false);
    expect(flushRanThisCycle([msgEntry(user("hi"), "a"), flush])).toBe(true);
    expect(flushRanThisCycle([flush, compactionEntry("c"), msgEntry(user("hi"), "b")])).toBe(false);
    expect(flushRanThisCycle([compactionEntry("c"), flush])).toBe(true);
  });

  test("a flush whose run ended aborted or in error doesn't count", () => {
    const flush = msgEntry(user(flushPrompt("compaction")), "f");
    const next = msgEntry(user("[discord:2 …]\nnext"), "n");
    expect(flushRanThisCycle([flush, msgEntry(assistant("", "toolUse"), "a1"), msgEntry(assistant("NO_REPLY"), "a2"), next])).toBe(true);
    expect(flushRanThisCycle([flush, msgEntry(assistant("", "toolUse"), "a1"), msgEntry(assistant("", "aborted"), "a2"), next])).toBe(false);
    expect(flushRanThisCycle([flush, msgEntry(assistant("", "error"), "a1")])).toBe(false);
    // Aborted before any reply, then the conversation moved on.
    expect(flushRanThisCycle([flush, next])).toBe(false);
  });
});

describe("buildHandoff", () => {
  test("lists the last asks, the last reply and changed files, redacted and without flush prompts", () => {
    const text = compactionHandoff(
      {
        messagesToSummarize: [
          user("[discord:1 2026-09-29 13:00 UTC]\nfirst"),
          user("[discord:2 2026-09-29 13:01 UTC]\nsecond"),
          user("[discord:3 2026-09-29 13:02 UTC]\nthird with sk-abcdefghijklmnopqrstuv"),
          user(`${FLUSH_MARKER} x`),
          assistant("Done. Open: migrate the DB next."),
        ] as never,
        turnPrefixMessages: [user("[discord:4 2026-09-29 13:03 UTC]\nfourth")] as never,
        fileOps: fileOps(["projects/app/src/db.ts"]),
      },
      "threshold",
      NOW,
    )!;
    expect(text).toContain("## Compaction handoff 14:05 UTC (threshold; no memory flush ran)");
    expect(text).not.toContain("first");
    expect(text).toContain("[discord:2 2026-09-29 13:01 UTC] second");
    expect(text).toContain("[discord:4 2026-09-29 13:03 UTC] fourth");
    expect(text).not.toContain("sk-abc");
    expect(text).not.toContain(FLUSH_MARKER);
    expect(text).toContain("Last reply (unverified assistant text; may list open items): Done. Open: migrate the DB next.");
    expect(text).toContain("Files changed: projects/app/src/db.ts");
  });

  test("nothing worth keeping gives null", () => {
    expect(compactionHandoff({ messagesToSummarize: [], turnPrefixMessages: [], fileOps: fileOps() } as never, "threshold", NOW)).toBeNull();
    expect(buildHandoff({ messages: [] }, { title: "x", detail: "y" }, NOW)).toBeNull();
  });

  test("JWTs, Discord tokens and cloud keys are redacted from the note", () => {
    const secrets = [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      ["MTA5ODc2NTQzMjEwOTg3NjU0", "GaBcDe", "abcdefghijklmnopqrstuvwxyz0123456789"].join("."),
      `AIza${"Sy0123456789abcdefghijklmnopqrstuv"}`,
    ];
    const text = buildHandoff({ messages: secrets.map((s) => user(`[discord:1 …]\nuse ${s}`)) }, { title: "Reset handoff", detail: "x" }, NOW)!;
    for (const s of secrets) expect(text).not.toContain(s.slice(0, 12));
  });

  test("the reset handoff lands in today's daily note", () => {
    const path = writeResetHandoff(home, [user("[discord:1 …]\nplan the trip"), assistant("drafted")], "timeout", NOW)!;
    expect(path).toBe(join(home, "memory", "2026-09-29.md"));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("## Reset handoff 14:05 UTC (memory flush timeout)");
    expect(text).toContain("plan the trip");
    expect(writeResetHandoff(home, [], "skipped", NOW)).toBeNull();
  });
});

describe("compaction handoff extension", () => {
  function handler() {
    const logs: string[] = [];
    let h: ((e: unknown) => unknown) | undefined;
    const pi = { on: (_: string, fn: (e: unknown) => unknown) => (h = fn) };
    createCompactionHandoffExtension({ home, now: () => NOW, log: { info: (_, m) => logs.push(m), warn: (_, m) => logs.push(m) } })(pi as never);
    return { h: h!, logs };
  }
  const event = (branchEntries: SessionEntry[]) => ({
    type: "session_before_compact",
    reason: "threshold",
    branchEntries,
    preparation: { messagesToSummarize: [user("[discord:9 2026-09-29 14:00 UTC]\nplan the trip")], turnPrefixMessages: [], fileOps: fileOps() },
  });
  const daily = () => join(home, "memory", "2026-09-29.md");

  test("appends a handoff to today's daily note when no flush ran, and never cancels compaction", () => {
    writeFileSync(daily(), "- earlier note\n");
    const { h } = handler();
    expect(h(event([msgEntry(user("hi"), "a")]))).toBeUndefined();
    const text = readFileSync(daily(), "utf8");
    expect(text.startsWith("- earlier note\n")).toBe(true);
    expect(text).toContain("plan the trip");
  });

  test("skips the handoff when a flush ran this cycle", () => {
    const { h } = handler();
    expect(h(event([msgEntry(user(flushPrompt("compaction")), "f")]))).toBeUndefined();
    expect(existsSync(daily())).toBe(false);
  });

  test("a write failure is logged, not thrown", () => {
    rmSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory"), "not a dir");
    const { h, logs } = handler();
    expect(h(event([]))).toBeUndefined();
    expect(logs).toContain("compaction handoff failed; compacting anyway");
  });
});

describe("memoryFilesSignature", () => {
  test("changes when a tracked memory file changes, not for other files", () => {
    writeFileSync(join(home, "USER.md"), "a");
    const s0 = memoryFilesSignature(home);
    writeFileSync(join(home, "notes.txt"), "x");
    mkdirSync(join(home, "scratch"));
    writeFileSync(join(home, "scratch", "y"), "y");
    expect(memoryFilesSignature(home)).toBe(s0);
    writeFileSync(join(home, "memory", "2026-09-29.md"), "n");
    const s1 = memoryFilesSignature(home);
    expect(s1).not.toBe(s0);
    writeFileSync(join(home, "USER.md"), "b");
    utimesSync(join(home, "USER.md"), new Date(0), new Date(1000));
    expect(memoryFilesSignature(home)).not.toBe(s1);
  });
});
