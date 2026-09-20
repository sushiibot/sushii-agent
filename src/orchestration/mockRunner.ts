import type { RunnerAdapter, RunnerEvent } from "./contracts.ts";

// Fakes a task lifecycle for exercising the transport without a real runner:
// running -> idle -> done, emitting one status/progress/handback event each.
export class MockRunnerAdapter implements RunnerAdapter {
  async start(input: { taskId: string; cwd: string; prompt: string }): Promise<{ nativeSessionId: string }> {
    return { nativeSessionId: `mock-${input.taskId}` };
  }

  async resume(_input: { taskId: string; nativeSessionId: string; prompt: string }): Promise<void> {}

  async interrupt(_taskId: string): Promise<void> {}

  async stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void> {
    onEvent({ kind: "status", taskId, status: "running" });
    onEvent({ kind: "progress", taskId, note: "mock task in progress" });
    onEvent({ kind: "status", taskId, status: "idle" });
    onEvent({ kind: "handback", taskId, summary: "mock task complete" });
    onEvent({ kind: "status", taskId, status: "done" });
  }
}
