import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RunnerEvent } from "../contracts.ts";
import { activityEntry, buildRunnerEvents, ClaudeCodeRunnerAdapter, parseClaudeStreamLine, RunnerEventReducer } from "./claudeCodeRunner.ts";

describe("activityEntry typing", () => {
  test("classifies tool calls, results, and text so surfaces can filter", () => {
    expect(activityEntry({ type: "tool_use", name: "bash", detail: "ls" })).toEqual({ line: "bash ls", atype: "tool" });
    expect(activityEntry({ type: "tool_result", name: "bash", output: "file.txt", isError: false })).toEqual({ line: "file.txt", atype: "result" });
    expect(activityEntry({ type: "tool_result", name: "bash", output: "boom", isError: true })).toEqual({ line: "✗ boom", atype: "result" });
    expect(activityEntry({ type: "assistant_text", text: "thinking" })).toEqual({ line: "thinking", atype: "text" });
  });
});

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
  test("maps a successful transcript to running -> progress(debounced) -> handback -> idle", () => {
    const events = buildRunnerEvents("task-1", SUCCESS_LINES, { debounceMs: 1500 });

    // Granular `activity` lines stream alongside (one per tool/text signal) — filter them out to
    // assert the debounced status/progress/handback backbone, which collapses same-batch activity
    // into exactly one progress note.
    const backbone = events.filter((e) => e.kind !== "activity");
    expect(backbone.map((e) => e.kind)).toEqual(["status", "progress", "handback", "status"]);
    // The live stream still saw each step.
    expect(events.some((e) => e.kind === "activity")).toBe(true);

    expect(backbone[0]).toMatchObject({ kind: "status", taskId: "task-1", status: "running" });

    const progress = backbone[1];
    expect(progress.kind).toBe("progress");
    if (progress.kind === "progress") {
      expect(progress.note).toContain("ran Read");
      expect(progress.note).toContain("ran Edit");
      expect(progress.note).toContain("Looking at the failing test now.");
    }

    const handback = backbone[2];
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

    expect(backbone[3]).toMatchObject({ kind: "status", taskId: "task-1", status: "idle" });
  });

  test("maps an error transcript to running -> progress -> failed", () => {
    const events = buildRunnerEvents("task-2", FAILURE_LINES).filter((e) => e.kind !== "activity");

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

describe("ClaudeCodeRunnerAdapter.resume (real process kill/exit, fixture binary in place of `claude`)", () => {
  test("killing the superseded process on resume emits no false 'failed', and the resumed stream reports running -> handback -> idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-runner-resume-test-"));
    // A stand-in for the `claude` CLI: on its first invocation it prints init then sleeps well past
    // resume()'s kill, so it's still alive to supersede; on the second (post-kill) invocation — a
    // marker file next to itself distinguishes the two — it prints init + a success result right
    // away. This is what actually exercises the kill-on-resume race; MockRunnerAdapter's resume() is
    // a no-op and can't.
    const fixtureBin = join(dir, "fake-claude.sh");
    writeFileSync(
      fixtureBin,
      [
        "#!/usr/bin/env bash",
        'DIR="$(dirname "$0")"',
        'MARKER="$DIR/.ran-once"',
        'if [ -f "$MARKER" ]; then',
        '  echo \'{"type":"system","subtype":"init","session_id":"sess-resumed"}\'',
        '  echo \'{"type":"result","subtype":"success","is_error":false,"result":"resumed run complete"}\'',
        "else",
        '  touch "$MARKER"',
        '  echo \'{"type":"system","subtype":"init","session_id":"sess-original"}\'',
        // `exec` replaces bash's own process image instead of forking a child — the sleep occupies
        // the exact PID Bun.spawn is watching, so kill() reaches it directly and its exit closes
        // the stdout pipe immediately. A forked (non-exec'd) `sleep 5` would instead leave an
        // orphaned grandchild holding the pipe's write end open for its full 5s even after the
        // (killed) bash parent exits, which is what made this test hang at ~5000ms.
        "  exec sleep 5",
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(fixtureBin, 0o755);

    try {
      const adapter = new ClaudeCodeRunnerAdapter({ claudeBin: fixtureBin, progressDebounceMs: 10 });
      const taskId = "task-resume-race";

      await adapter.start({ taskId, cwd: dir, prompt: "go" });

      const oldEvents: RunnerEvent[] = [];
      const oldStreamDone = adapter.stream(taskId, (e) => oldEvents.push(e));

      // Let the original process actually reach its sleep before superseding it.
      await new Promise((r) => setTimeout(r, 100));

      await adapter.resume({ taskId, nativeSessionId: "sess-original", cwd: "", prompt: "continue" });
      await oldStreamDone;

      expect(oldEvents.some((e) => e.kind === "status" && e.status === "failed")).toBe(false);

      const newEvents: RunnerEvent[] = [];
      await adapter.stream(taskId, (e) => newEvents.push(e));

      expect(newEvents.some((e) => e.kind === "status" && e.status === "running")).toBe(true);
      expect(newEvents.some((e) => e.kind === "handback" && e.summary === "resumed run complete")).toBe(true);
      expect(newEvents.some((e) => e.kind === "status" && e.status === "idle")).toBe(true);
      expect(newEvents.some((e) => e.kind === "status" && e.status === "failed")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
