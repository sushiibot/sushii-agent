import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callKey, createLoopGuardExtension, LOOP_GUARD_CUSTOM_TYPE, LOOP_NUDGE, repeatReason } from "./loopGuard.ts";

type Handler = (event: unknown) => unknown;
type CallResult = { block: boolean; reason: string } | undefined;

function harness() {
  const handlers = new Map<string, Handler>();
  const sent: Array<{ message: { customType: string; content: string }; options: unknown }> = [];
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    sendMessage: (message: { customType: string; content: string }, options: unknown) => sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  void createLoopGuardExtension()(pi);
  return {
    sent,
    start: () => handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "hi" }),
    call: (toolName: string, input: Record<string, unknown>) =>
      handlers.get("tool_call")!({ type: "tool_call", toolCallId: "c", toolName, input }) as CallResult,
    result: (toolName: string, input: Record<string, unknown>, isError = false) =>
      handlers.get("tool_result")!({ type: "tool_result", toolName, input, isError, content: [] }),
  };
}

describe("loop guard", () => {
  test("the third identical call is blocked", () => {
    const h = harness();
    h.start();
    const read = { path: "a.ts", offset: 1 };
    expect(h.call("read", read)).toBeUndefined();
    expect(h.call("read", { offset: 1, path: "a.ts" })).toBeUndefined();
    expect(h.call("read", read)).toEqual({ block: true, reason: repeatReason(2) });
    expect(h.call("read", read)?.block).toBe(true);
  });

  test("different args are allowed", () => {
    const h = harness();
    h.start();
    for (let i = 0; i < 5; i++) expect(h.call("read", { path: `f${i}.ts` })).toBeUndefined();
    expect(h.call("bash", { command: "ls" })).toBeUndefined();
    expect(h.call("bash", { command: "ls -a" })).toBeUndefined();
  });

  test("the same failing command repeated is blocked, whitespace and timeout aside", () => {
    const h = harness();
    h.start();
    expect(h.call("bash", { command: "curl http://x" })).toBeUndefined();
    h.result("bash", { command: "curl http://x" }, true);
    expect(h.call("bash", { command: "curl  http://x", timeout: 30 })).toBeUndefined();
    expect(h.call("bash", { command: "curl http://x ", timeout: 60 })?.block).toBe(true);
  });

  test("the nudge comes once, after the second block", () => {
    const h = harness();
    h.start();
    for (let i = 0; i < 3; i++) h.call("read", { path: "a.ts" });
    expect(h.sent).toHaveLength(0);
    h.call("read", { path: "a.ts" });
    expect(h.sent).toEqual([{ message: { customType: LOOP_GUARD_CUSTOM_TYPE, content: LOOP_NUDGE, display: false } as never, options: { deliverAs: "steer" } }]);
    h.call("read", { path: "a.ts" });
    expect(h.sent).toHaveLength(1);
  });

  test("resets per run", () => {
    const h = harness();
    h.start();
    for (let i = 0; i < 4; i++) h.call("read", { path: "a.ts" });
    h.start();
    expect(h.call("read", { path: "a.ts" })).toBeUndefined();
    expect(h.call("read", { path: "a.ts" })).toBeUndefined();
    for (let i = 0; i < 2; i++) h.call("read", { path: "a.ts" });
    expect(h.sent).toHaveLength(2);
  });

  test("rerunning the tests after each edit is never blocked", () => {
    const h = harness();
    h.start();
    const test = { command: "cd projects/app && bun test" };
    for (let i = 0; i < 5; i++) {
      expect(h.call("bash", test)).toBeUndefined();
      h.result("bash", test, true);
      h.result("edit", { path: "projects/app/a.ts", edits: [] });
    }
  });

  test("a failed edit doesn't reset the count", () => {
    const h = harness();
    h.start();
    const test = { command: "bun test" };
    h.call("bash", test);
    h.call("bash", test);
    h.result("edit", { path: "a.ts", edits: [] }, true);
    expect(h.call("bash", test)?.block).toBe(true);
  });

  test("call keys ignore arg order", () => {
    expect(callKey("read", { a: 1, b: { c: 2, d: 3 } })).toBe(callKey("read", { b: { d: 3, c: 2 }, a: 1 }));
    expect(callKey("read", { a: 1 })).not.toBe(callKey("grep", { a: 1 }));
  });
});
