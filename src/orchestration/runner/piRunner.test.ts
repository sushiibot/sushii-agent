import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { piEventToSignals } from "./piRunner.ts";

// The mapping is the pure, model-free core of the Pi adapter — the rest is session/queue plumbing
// that needs a live OpenRouter run to exercise. Cast fixtures to the event union: we only touch the
// fields the mapper reads.
const ev = (e: unknown) => e as AgentSessionEvent;

describe("piEventToSignals", () => {
  test("tool_execution_start → a tool_use signal named for the tool", () => {
    const acc = { finalText: "", tokens: undefined as number | undefined };
    const sigs = piEventToSignals(ev({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }), acc);
    expect(sigs).toEqual([{ type: "tool_use", name: "bash" }]);
  });

  test("text_end → an assistant_text signal; text_delta accumulates final text", () => {
    const acc = { finalText: "", tokens: undefined as number | undefined };
    piEventToSignals(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } }), acc);
    piEventToSignals(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } }), acc);
    expect(acc.finalText).toBe("Hello");
    const sigs = piEventToSignals(ev({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "Hello" } }), acc);
    expect(sigs).toEqual([{ type: "assistant_text", text: "Hello" }]);
  });

  test("done → records token usage on the accumulator; emits no signal itself", () => {
    const acc = { finalText: "", tokens: undefined as number | undefined };
    const sigs = piEventToSignals(
      ev({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop", message: { usage: { input: 100, output: 40 } } } }),
      acc,
    );
    expect(sigs).toEqual([]);
    expect(acc.tokens).toBe(140);
  });

  test("unrelated events (turn_start, thinking) produce no signals", () => {
    const acc = { finalText: "", tokens: undefined as number | undefined };
    expect(piEventToSignals(ev({ type: "turn_start" }), acc)).toEqual([]);
    expect(piEventToSignals(ev({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }), acc)).toEqual([]);
  });
});
