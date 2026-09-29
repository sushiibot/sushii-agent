import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RunLog } from "./runLog.ts";
import { observeRuns } from "./runObserver.ts";

class FakeSession {
  disposed = false;
  private listeners = new Set<(e: AgentSessionEvent) => void>();
  subscribe(l: (e: AgentSessionEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: unknown) {
    for (const l of this.listeners) l(e as AgentSessionEvent);
  }
  dispose() {
    this.disposed = true;
  }
  user(text: string) {
    this.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
  }
  assistant(text: string, stopReason: string, usage = { input: 100, output: 20, cost: { total: 0.01 } }, errorMessage?: string) {
    this.emit({
      type: "message_end",
      message: { role: "assistant", provider: "openrouter", model: "m", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage, usage },
    });
  }
  tool() {
    this.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    this.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false });
  }
}

let dir: string;
let log: RunLog;
let session: FakeSession;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-runobs-"));
  log = new RunLog(dir);
  session = new FakeSession();
  observeRuns(session, { recorder: log, sessionFile: "/agent/chat/s.jsonl", agentName: "main", defaultModel: "m" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("observeRuns", () => {
  test("a main turn produces a start and an end record with usage", () => {
    session.emit({ type: "agent_start" });
    session.emit({ type: "turn_start" });
    session.emit({ type: "message_start", message: { role: "system", content: "" } });
    session.emit({ type: "message_end", message: { role: "system", content: "" } });
    session.user("[discord:1 2026-09-29 10:00 UTC]\nwhat's up");
    expect(log.listRuns()[0]).toMatchObject({ agentName: "main", status: "running", task: "[discord:1 2026-09-29 10:00 UTC]\nwhat's up" });
    session.tool();
    session.assistant("", "toolUse");
    session.user("a steer in the same run");
    session.assistant("all good", "stop");
    session.emit({ type: "agent_end", messages: [], willRetry: false });
    session.emit({ type: "agent_settled" });

    const runs = log.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agentName: "main",
      sessionFile: "/agent/chat/s.jsonl",
      status: "done",
      usage: { inputTokens: 200, outputTokens: 40, costUsd: 0.02 },
      resultSummary: "all good",
    });
    expect(runs[0].task).toContain("what's up");
  });

  test("each turn is its own run", () => {
    for (const text of ["one", "two"]) {
      session.emit({ type: "agent_start" });
      session.user(text);
      session.assistant(`re ${text}`, "stop");
      session.emit({ type: "agent_settled" });
    }
    expect(log.listRuns().map((r) => [r.task, r.status])).toEqual([
      ["two", "done"],
      ["one", "done"],
    ]);
  });

  test("an abort before any reply is recorded as aborted", () => {
    session.emit({ type: "agent_start" });
    session.user("long task");
    session.assistant("", "aborted", { input: 0, output: 0, cost: { total: 0 } });
    session.emit({ type: "agent_settled" });
    expect(log.listRuns()[0]).toMatchObject({ status: "aborted", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  test("a turn stopped mid tool use is recorded as aborted", () => {
    session.emit({ type: "agent_start" });
    session.user("run the tests");
    session.assistant("", "toolUse");
    session.tool();
    session.emit({ type: "agent_settled" });
    expect(log.listRuns()[0]).toMatchObject({ status: "aborted" });
  });

  test("a model error is recorded as failed with the error as the summary", () => {
    session.emit({ type: "agent_start" });
    session.user("hi");
    session.assistant("", "error", undefined, "429 rate limited");
    session.emit({ type: "agent_settled" });
    expect(log.listRuns()[0]).toMatchObject({ status: "failed", resultSummary: "429 rate limited" });
  });

  test("a run without a user message is still recorded", () => {
    session.emit({ type: "agent_start" });
    session.assistant("follow-up", "stop");
    session.emit({ type: "agent_settled" });
    expect(log.listRuns()[0]).toMatchObject({ task: "", status: "done" });
  });

  test("disposing mid-run closes the run as aborted", () => {
    session.emit({ type: "agent_start" });
    session.user("hi");
    session.dispose();
    expect(session.disposed).toBe(true);
    expect(log.listRuns()[0]).toMatchObject({ status: "aborted" });
    session.emit({ type: "agent_start" });
    expect(log.listRuns()).toHaveLength(1);
  });
});
