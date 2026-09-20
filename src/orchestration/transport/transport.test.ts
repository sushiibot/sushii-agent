import { describe, expect, test } from "bun:test";
import type { RunnerEvent } from "../contracts.ts";
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
});
