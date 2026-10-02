import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mapSessionEvent, newRunAccumulator } from "./events.ts";

const update = (type: string, delta = "") =>
  ({
    type: "message_update",
    assistantMessageEvent: { type, delta },
  }) as AgentSessionEvent;

test("only streamed reasoning changes waiting to thinking; repeated deltas reveal no content", () => {
  const acc = newRunAccumulator();
  expect(mapSessionEvent(update("start"), acc)).toEqual([]);
  expect(mapSessionEvent(update("thinking_start"), acc)).toEqual([]);
  expect(mapSessionEvent(update("thinking_delta"), acc)).toEqual([]);
  expect(
    mapSessionEvent(update("thinking_delta", "private reasoning"), acc),
  ).toEqual([{ type: "model_activity", activity: "thinking" }]);
  expect(
    mapSessionEvent(update("thinking_delta", "more private reasoning"), acc),
  ).toEqual([]);
  expect(mapSessionEvent(update("thinking_end"), acc)).toEqual([
    { type: "model_activity", activity: "waiting" },
  ]);
});

test("models without reasoning stay waiting and reasoning after text or a tool leaves progress unchanged", () => {
  const acc = newRunAccumulator();
  expect(mapSessionEvent(update("text_delta", "reply"), acc)).toEqual([
    { type: "text_delta", text: "reply" },
  ]);
  expect(mapSessionEvent(update("thinking_delta", "reasoning"), acc)).toEqual(
    [],
  );
  const tools = newRunAccumulator();
  mapSessionEvent(
    {
      type: "tool_execution_start",
      toolName: "read",
      args: {},
    } as AgentSessionEvent,
    tools,
  );
  expect(mapSessionEvent(update("thinking_delta", "reasoning"), tools)).toEqual(
    [],
  );
});

test("an interrupted reasoning stream returns to waiting before the next provider attempt", () => {
  const acc = newRunAccumulator();
  mapSessionEvent(update("thinking_delta", "private"), acc);
  expect(mapSessionEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable" } } as unknown as AgentSessionEvent, acc)).toEqual([{ type: "model_activity", activity: "waiting" }]);
  expect(mapSessionEvent(update("thinking_delta", "retry reasoning"), acc)).toEqual([{ type: "model_activity", activity: "thinking" }]);
});


test("tool execution events preserve Pi call IDs for exact approval/result correlation", () => {
  const acc = newRunAccumulator();
  expect(mapSessionEvent({ type: "tool_execution_start", toolCallId: "call1", toolName: "bash", args: { command: "ls" } } as AgentSessionEvent, acc)).toEqual([{ type: "tool_start", name: "bash", summary: "ls", toolCallId: "call1" }]);
  expect(mapSessionEvent({ type: "tool_execution_end", toolCallId: "call1", toolName: "bash", isError: false, result: { content: [] } } as unknown as AgentSessionEvent, acc)).toEqual([{ type: "tool_end", name: "bash", ok: true, toolCallId: "call1" }]);
});
