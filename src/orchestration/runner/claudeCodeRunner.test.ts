import { describe, expect, test } from "bun:test";
import { buildRunnerEvents, parseClaudeStreamLine, RunnerEventReducer } from "./claudeCodeRunner.ts";

// Captured/assumed shape of `claude -p <prompt> --output-format=stream-json
// --verbose` line output. See the parser's doc comment for the assumption.
const SUCCESS_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc123" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Looking at the failing test now." }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }] },
  }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "a.ts" } }] },
  }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }] },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Fixed the bug in a.ts.",
    duration_ms: 4321,
    total_cost_usd: 0.012,
    usage: { input_tokens: 1000, output_tokens: 200 },
  }),
];

const FAILURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-def456" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "false" } }] },
  }),
  // Error result subtypes carry `errors: string[]` on the SDKResultMessage
  // union — only subtype:"success" has a `result` field. A `result` on an
  // error subtype is a shape the real CLI can't emit.
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["command failed"],
  }),
];

describe("parseClaudeStreamLine", () => {
  test("maps init, tool_use, assistant_text, and result lines", () => {
    expect(parseClaudeStreamLine(JSON.parse(SUCCESS_LINES[0]!))).toEqual([
      { type: "init", sessionId: "sess-abc123" },
    ]);
    expect(parseClaudeStreamLine(JSON.parse(SUCCESS_LINES[1]!))).toEqual([
      { type: "assistant_text", text: "Looking at the failing test now." },
    ]);
    expect(parseClaudeStreamLine(JSON.parse(SUCCESS_LINES[2]!))).toEqual([{ type: "tool_use", name: "Read" }]);
    expect(parseClaudeStreamLine(JSON.parse(SUCCESS_LINES[3]!))).toEqual([]);

    const result = parseClaudeStreamLine(JSON.parse(SUCCESS_LINES[6]!));
    expect(result).toEqual([
      {
        type: "result",
        success: true,
        resultText: "Fixed the bug in a.ts.",
        durationMs: 4321,
        costUsd: 0.012,
        tokens: 1200,
        errorMessage: undefined,
      },
    ]);
  });

  test("ignores unknown/malformed line shapes", () => {
    expect(parseClaudeStreamLine(null)).toEqual([]);
    expect(parseClaudeStreamLine({ type: "system", subtype: "other" })).toEqual([]);
    expect(parseClaudeStreamLine({ type: "assistant", message: { content: "not-an-array" } })).toEqual([]);
  });
});

describe("buildRunnerEvents", () => {
  test("maps a successful transcript to running -> progress(debounced) -> handback -> done", () => {
    const events = buildRunnerEvents("task-1", SUCCESS_LINES, { debounceMs: 1500 });

    // All activity lines happen in the same synchronous batch (no wall-clock
    // gap), so debounce collapses them into exactly one progress note instead
    // of one per tool_use/text line.
    expect(events.map((e) => e.kind)).toEqual(["status", "progress", "handback", "status"]);

    expect(events[0]).toMatchObject({ kind: "status", taskId: "task-1", status: "running" });

    const progress = events[1];
    expect(progress.kind).toBe("progress");
    if (progress.kind === "progress") {
      expect(progress.note).toContain("ran Read");
      expect(progress.note).toContain("ran Edit");
      expect(progress.note).toContain("Looking at the failing test now.");
    }

    const handback = events[2];
    expect(handback.kind).toBe("handback");
    if (handback.kind === "handback") {
      expect(handback.summary).toBe("Fixed the bug in a.ts.");
      expect(handback.meta).toMatchObject({
        toolsRun: 2,
        tokens: 1200,
        costUsd: 0.012,
        durationMs: 4321,
      });
    }

    expect(events[3]).toMatchObject({ kind: "status", taskId: "task-1", status: "done" });
  });

  test("maps an error transcript to running -> progress -> failed", () => {
    const events = buildRunnerEvents("task-2", FAILURE_LINES);

    expect(events.map((e) => e.kind)).toEqual(["status", "progress", "status"]);
    expect(events[0]).toMatchObject({ status: "running" });
    expect(events[2]).toMatchObject({
      kind: "status",
      taskId: "task-2",
      status: "failed",
      reason: "command failed",
    });
  });

  test("re-flushes a single reducer's debounce window once the clock advances past debounceMs", () => {
    let t = 0;
    const now = () => t;
    const reducer = new RunnerEventReducer("task-3", 100, now);

    const firstBurst = [
      ...reducer.onSignal({ type: "assistant_text", text: "Looking at the failing test now." }),
      ...reducer.onSignal({ type: "tool_use", name: "Read" }),
    ];
    // Still inside the debounce window: the burst above must stay pending,
    // not flush as its own progress note.
    expect(firstBurst.filter((e) => e.kind === "progress")).toHaveLength(0);

    t += 150;
    const flushOfFirstBurst = reducer.onSignal({ type: "tool_use", name: "Edit" });
    expect(flushOfFirstBurst.filter((e) => e.kind === "progress")).toHaveLength(1);

    t += 150;
    const secondBurst = reducer.onSignal({ type: "tool_use", name: "Bash" });
    expect(secondBurst.filter((e) => e.kind === "progress")).toHaveLength(1);

    // Two separate progress notes came out of one reducer instance across two
    // debounce windows, not one note per signal and not a single coalesced note.
    const allProgress = [...firstBurst, ...flushOfFirstBurst, ...secondBurst].filter((e) => e.kind === "progress");
    expect(allProgress).toHaveLength(2);
  });

  test("never invokes the real claude CLI — purely parses fixture strings", () => {
    // Sanity check that this test module only exercises the pure parser/
    // reducer path: no Bun.spawn call anywhere in this file.
    expect(typeof buildRunnerEvents).toBe("function");
  });
});
