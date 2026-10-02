import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { promptToSettle } from "./jobSession.ts";

function session(
  run: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
) {
  let listener: (event: AgentSessionEvent) => void = () => {};
  let aborted = false;
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
    ] as never,
    subscribe: (fn: typeof listener) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    prompt: async () => run((event) => listener(event)),
    abort: async () => {
      aborted = true;
    },
    dispose: () => {},
    wasAborted: () => aborted,
  };
}
const compactStart = {
  type: "compaction_start",
  reason: "overflow",
} as AgentSessionEvent;
const compactEnd = {
  type: "compaction_end",
  reason: "overflow",
  aborted: false,
  willRetry: true,
} as AgentSessionEvent;

test("overflow compaction pauses the job work budget and the continued reply settles it", async () => {
  const s = session(async (emit) => {
    emit(compactStart);
    await Bun.sleep(100);
    emit(compactEnd);
    await Bun.sleep(5);
    emit({
      type: "agent_end",
      messages: [],
      willRetry: true,
    } as AgentSessionEvent);
    emit({ type: "agent_settled" });
  });
  expect(await promptToSettle(s, "work", 50)).toBe("done");
  expect(s.wasAborted()).toBe(false);
});

test("ordinary work still times out and aborts; an agent_end alone is not settled", async () => {
  const s = session(async (emit) => {
    emit({
      type: "agent_end",
      messages: [],
      willRetry: true,
    } as AgentSessionEvent);
  });
  await expect(promptToSettle(s, "work", 10)).rejects.toThrow("work time");
  expect(s.wasAborted()).toBe(true);
});

test("a stuck compaction has its own bounded deadline and aborts", async () => {
  const s = session(async (emit) => { emit(compactStart); });
  await expect(promptToSettle(s, "work", 1000, 10)).rejects.toThrow("compaction did not finish within 10ms");
  expect(s.wasAborted()).toBe(true);
});
