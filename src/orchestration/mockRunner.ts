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
    const events: RunnerEvent[] = [
      { kind: "status", taskId, status: "running" },
      { kind: "progress", taskId, note: "mock task in progress" },
      { kind: "status", taskId, status: "idle" },
      { kind: "handback", taskId, summary: "mock task complete" },
      { kind: "status", taskId, status: "done" },
    ];
    for (const event of events) {
      // Yield a microtask between emits so ordering assertions exercise
      // real interleaving instead of one synchronous burst.
      await Promise.resolve();
      onEvent(event);
    }
  }
}
