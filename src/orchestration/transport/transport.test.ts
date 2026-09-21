import { describe, expect, test } from "bun:test";
import type { RunnerAdapter, RunnerEvent } from "../contracts.ts";
import { MockRunnerAdapter } from "../mockRunner.ts";
import { OrchestrationClient } from "./client.ts";
import { OrchestrationServer } from "./server.ts";

describe("orchestration transport round-trip", () => {
  test("register, start, and receive events in order", async () => {
    const events: RunnerEvent[] = [];
    const registered: { id: string | null } = { id: null };

    const server = new OrchestrationServer({
      onEvent: (_runnerId, event) => events.push(event),
      onRegister: (runnerId: string) => {
        registered.id = runnerId;
      },
    });
    server.listen();

    const client = new OrchestrationClient({
      url: server.url,
      runnerId: "mock-runner-1",
      kind: "mock",
      adapter: new MockRunnerAdapter(),
    });

    try {
      await client.connect();
      client.listen();

      expect(registered.id).toBe("mock-runner-1");
      expect(server.isConnected("mock-runner-1")).toBe(true);

      const result = await server.start("mock-runner-1", {
        taskId: "task-1",
        cwd: "/tmp",
        prompt: "do the thing",
      });
      expect(result).toEqual({ nativeSessionId: "mock-task-1" });

      // Events are pushed as fire-and-forget notifications after the
      // start response; poll until the terminal "done" status arrives.
      const deadline = Date.now() + 2000;
      while (events.length < 5 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(events.map((e) => e.kind)).toEqual([
        "status",
        "progress",
        "status",
        "handback",
        "status",
      ]);
      expect(events[0]).toMatchObject({ kind: "status", status: "running", taskId: "task-1" });
      expect(events[2]).toMatchObject({ kind: "status", status: "idle" });
      expect(events[3]).toMatchObject({ kind: "handback", summary: "mock task complete" });
      expect(events[4]).toMatchObject({ kind: "status", status: "done" });
    } finally {
      client.close();
      server.stop();
    }
  });

  test("resume always starts a fresh subscription, even racing an in-flight stream from start()", async () => {
    // Contract change: resume() forces a new subscription unconditionally, because a real runner
    // adapter's resume() may have killed and respawned the underlying process — the earlier
    // "reuse the existing stream" policy is exactly the guard-race MAJOR finding (a resumed
    // process's stream could be silently skipped forever). MockRunnerAdapter can't itself model a
    // kill/respawn, so here re-subscribing just means the fixed event sequence replays twice —
    // this test only asserts the client's subscription bookkeeping, not adapter semantics.
    let streamCalls = 0;
    // Delay before the underlying stream starts emitting, so the "already
    // streaming" flag is still set when resume() races in right behind start().
    class CountingMockRunnerAdapter extends MockRunnerAdapter {
      override async stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void> {
        streamCalls++;
        await new Promise((r) => setTimeout(r, 50));
        return super.stream(taskId, onEvent);
      }
    }

    const events: RunnerEvent[] = [];
    const server = new OrchestrationServer({
      onEvent: (_runnerId, event) => events.push(event),
    });
    server.listen();

    const client = new OrchestrationClient({
      url: server.url,
      runnerId: "mock-runner-2",
      kind: "mock",
      adapter: new CountingMockRunnerAdapter(),
    });

    try {
      await client.connect();
      client.listen();

      await server.start("mock-runner-2", {
        taskId: "task-2",
        cwd: "/tmp",
        prompt: "do the thing",
      });

      // Race a resume against the in-flight stream() started by start(); it must start a second,
      // independent subscription rather than being silently dropped by the first's guard entry.
      await server.resume("mock-runner-2", {
        taskId: "task-2",
        nativeSessionId: "mock-task-2",
        cwd: "/tmp",
        prompt: "continue",
      });

      const deadline = Date.now() + 2000;
      while (events.length < 10 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(streamCalls).toBe(2);
      // Both subscriptions run to completion and their events land in order.
      expect(events.map((e) => e.kind)).toEqual([
        "status", "progress", "status", "handback", "status",
        "status", "progress", "status", "handback", "status",
      ]);
    } finally {
      client.close();
      server.stop();
    }
  });

  test("malformed register payload gets a JSON-RPC error, not a crash", async () => {
    const server = new OrchestrationServer({ onEvent: () => {} });
    server.listen();

    try {
      const raw = new WebSocket(server.url);
      const response = await new Promise<{ id: unknown; error?: { message: string } }>(
        (resolve, reject) => {
          raw.addEventListener("open", () => {
            raw.send(
              JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runner/register", params: {} }),
            );
          });
          raw.addEventListener("message", (event) => {
            resolve(JSON.parse(event.data.toString()));
          });
          raw.addEventListener("error", () => reject(new Error("ws error")));
        },
      );
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      raw.close();

      // The server process must still be alive and able to serve a valid register.
      const client = new OrchestrationClient({
        url: server.url,
        runnerId: "mock-runner-3",
        kind: "mock",
        adapter: new MockRunnerAdapter(),
      });
      await client.connect();
      client.listen();
      expect(server.isConnected("mock-runner-3")).toBe(true);
      client.close();
    } finally {
      server.stop();
    }
  });

  test("a rejecting adapter.stream() surfaces a failed status instead of crashing", async () => {
    class ThrowingAdapter implements RunnerAdapter {
      async start(input: { taskId: string }): Promise<{ nativeSessionId: string }> {
        return { nativeSessionId: `throwing-${input.taskId}` };
      }
      async resume(): Promise<void> {}
      async interrupt(): Promise<void> {}
      async stop(): Promise<void> {}
      async stream(): Promise<void> {
        throw new Error("adapter blew up");
      }
    }

    const events: RunnerEvent[] = [];
    const server = new OrchestrationServer({
      onEvent: (_runnerId, event) => events.push(event),
    });
    server.listen();

    const client = new OrchestrationClient({
      url: server.url,
      runnerId: "mock-runner-4",
      kind: "mock",
      adapter: new ThrowingAdapter(),
    });

    try {
      await client.connect();
      client.listen();

      await server.start("mock-runner-4", {
        taskId: "task-4",
        cwd: "/tmp",
        prompt: "do the thing",
      });

      const deadline = Date.now() + 2000;
      while (events.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "status",
        taskId: "task-4",
        status: "failed",
        reason: "adapter blew up",
      });
    } finally {
      client.close();
      server.stop();
    }
  });
});
