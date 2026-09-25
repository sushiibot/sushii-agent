import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { applySchema } from "../db/index.ts";
import { TaskRegistry } from "./registry.ts";
import { MockRunnerAdapter } from "./mockRunner.ts";
import { OrchestrationClient } from "./transport/client.ts";
import { AuthzError, Dispatcher } from "./dispatcher.ts";
import { TaskMessageStore } from "./taskMessages.ts";
import type { AuthzInput, RunnerEvent } from "./contracts.ts";

function testRegistry(): TaskRegistry {
  const db = new Database(":memory:");
  applySchema(db);
  return new TaskRegistry(db);
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Dispatcher", () => {
  test("task-message reply persists and uses normal follow-up without steering or changing running status", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const registry = new TaskRegistry(db);
    const messageStore = new TaskMessageStore(db);
    const dispatcher = new Dispatcher(registry, () => true, {}, messageStore);
    dispatcher.listen();
    class FollowUpRunner extends MockRunnerAdapter {
      followUps: Array<{ taskId: string; text: string }> = [];
      override async followUp(input: { taskId: string; text: string }): Promise<{ delivered: boolean }> {
        this.followUps.push(input);
        return { delivered: true };
      }
      override async stream(taskId: string, onEvent: (event: RunnerEvent) => void): Promise<void> {
        onEvent({ kind: "status", taskId, status: "running" });
        await new Promise<void>(() => {}); // keep a realistic active session until the test closes it
      }
    }
    const adapter = new FollowUpRunner();
    const runner = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "messaging-runner", kind: "mock", adapter });
    try {
      await runner.connect(); runner.listen();
      await waitFor(() => dispatcher.isRunnerLive("messaging-runner"));
      const task = await dispatcher.dispatch({ principal: "owner", runnerId: "messaging-runner", cwd: "/tmp", project: null, prompt: "work", space: "discord:dm", spawnedFromSurface: "discord" });
      const agentMessage = dispatcher.storeAgentMessage(task.id, "Need a preference?", "agent-message-1");
      dispatcher.markTaskMessageDelivered(agentMessage.id, "discord-message-1");
      const reply = await dispatcher.replyToTaskMessage({ principal: "owner", messageId: agentMessage.id, text: "Use the smaller option", space: "discord:dm", isPrivate: true });
      expect(reply).toMatchObject({ direction: "owner_to_agent", status: "delivered", content: "Use the smaller option" });
      expect(adapter.followUps).toEqual([{ taskId: task.id, text: "Use the smaller option" }]);
      expect(adapter.lastSteer).toBeNull();
      expect(dispatcher.readTask(task.id)?.status).toBe("running");
    } finally {
      runner.close(); dispatcher.stop(); db.close();
    }
  });

  test("idle task reply resumes that task using the message content", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const registry = new TaskRegistry(db);
    const store = new TaskMessageStore(db);
    const dispatcher = new Dispatcher(registry, () => true, {}, store);
    dispatcher.listen();
    class ResumeRunner extends MockRunnerAdapter {
      resumes: string[] = [];
      override async resume(input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string }): Promise<void> { this.resumes.push(input.prompt); }
    }
    const adapter = new ResumeRunner();
    const runner = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "resume-message-runner", kind: "mock", adapter });
    try {
      await runner.connect(); runner.listen();
      await waitFor(() => dispatcher.isRunnerLive("resume-message-runner"));
      const task = registry.create({ createdBy: "owner", runnerId: "resume-message-runner", project: null, cwd: "/tmp", nativeSessionId: "native", resumeCursor: null, status: "idle", statusReason: null, summary: null, spawnedFromSurface: "discord", threadRefs: [] });
      const source = store.create({ taskId: task.id, direction: "agent_to_owner", content: "Question?" });
      store.markDelivered(source.id, "discord-message-id");
      const reply = await dispatcher.replyToTaskMessage({ principal: "owner", messageId: source.id, text: "Proceed with A", space: "discord:dm", isPrivate: true });
      expect(reply.status).toBe("delivered");
      expect(adapter.resumes).toEqual(["Proceed with A"]);
      expect(registry.get(task.id)?.status).toBe("idle"); // status changes only when runner reports it
      expect(store.list(task.id).map((m) => m.status)).toEqual(["delivered", "delivered"]);
    } finally { runner.close(); dispatcher.stop(); db.close(); }
  });

  test("dispatch is authz-gated first — denied before any task row is created", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => false);
    dispatcher.listen();
    try {
      await expect(
        dispatcher.dispatch({
          principal: "someone",
          runnerId: "runner-x",
          cwd: "/tmp",
          project: null,
          prompt: "do it",
          space: "discord:guild-1",
          spawnedFromSurface: "discord",
        }),
      ).rejects.toBeInstanceOf(AuthzError);
      expect(dispatcher.listRunning("someone")).toEqual([]);
    } finally {
      dispatcher.stop();
    }
  });

  test("forwards isPrivate to canFn for every gated verb (dispatch/resume/halt/steer)", async () => {
    // A recording spy that denies: proves the isPrivate signal reaches canFn on all four call sites
    // without needing a live runner. FakeDispatcher in runners/index.test.ts never calls canFn, so
    // this is the only place the four dispatcher call sites are checked.
    const seen: AuthzInput[] = [];
    const canFn = (input: AuthzInput): boolean => {
      seen.push(input);
      return false;
    };
    const dispatcher = new Dispatcher(testRegistry(), canFn);
    dispatcher.listen();
    try {
      await expect(
        dispatcher.dispatch({
          principal: "p",
          runnerId: "r",
          cwd: "/tmp",
          project: null,
          prompt: "go",
          space: "slack:T1",
          isPrivate: true,
          spawnedFromSurface: "slack",
        }),
      ).rejects.toBeInstanceOf(AuthzError);
      await expect(dispatcher.resume({ principal: "p", taskId: "t", prompt: "go", space: "slack:T1", isPrivate: true })).rejects.toBeInstanceOf(AuthzError);
      await expect(dispatcher.haltTask({ principal: "p", taskId: "t", space: "slack:T1", isPrivate: true })).rejects.toBeInstanceOf(AuthzError);
      await expect(dispatcher.steer({ principal: "p", taskId: "t", space: "slack:T1", text: "go", isPrivate: true })).rejects.toBeInstanceOf(AuthzError);

      expect(seen.map((i) => i.capability)).toEqual(["runner.dispatch", "session.resume", "session.stop", "session.resume"]);
      expect(seen.every((i) => i.isPrivate === true)).toBe(true);
    } finally {
      dispatcher.stop();
    }
  });

  test("dispatch rejects a cwd outside the runner's declared projects; allows nested paths", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "scoped-runner",
      kind: "mock",
      projects: ["/home/drk/sushii/sushii-sns"],
      adapter: new MockRunnerAdapter(),
    });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("scoped-runner"));

      const base = {
        principal: "owner-1",
        runnerId: "scoped-runner",
        project: null,
        prompt: "go",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      };
      await expect(dispatcher.dispatch({ ...base, cwd: "/home/drk/sushii/sushii-agent" })).rejects.toThrow(/not within any project/);
      // exact match and a nested path are both in scope
      const nested = await dispatcher.dispatch({ ...base, cwd: "/home/drk/sushii/sushii-sns/src" });
      expect(nested.status).toBe("running");
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("a runner declaring only a workspaceRoot (no projects) still engages the fence", async () => {
    // The clone-on-demand boot case: empty RUNNER_ROOTS, nothing cloned yet — the fence must not
    // be permissive just because no projects are declared. A cwd under the workspace passes; one
    // outside is rejected.
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "clone-runner",
      kind: "mock",
      projects: [],
      workspaceRoot: "/data/workspace",
      adapter: new MockRunnerAdapter(),
    });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("clone-runner"));

      const base = {
        principal: "owner-1",
        runnerId: "clone-runner",
        project: null,
        prompt: "go",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      };
      await expect(dispatcher.dispatch({ ...base, cwd: "/etc" })).rejects.toThrow(/not within any project/);
      const inWorkspace = await dispatcher.dispatch({ ...base, cwd: "/data/workspace/owner-1/acme-widgets" });
      expect(inWorkspace.status).toBe("running");
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("clone-on-demand derives a per-principal cwd under the workspace root", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "clone-runner",
      kind: "mock",
      workspaceRoot: "/data/workspace",
      adapter: new MockRunnerAdapter(),
    });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("clone-runner"));

      const task = await dispatcher.dispatch({
        principal: "owner-1",
        runnerId: "clone-runner",
        cwd: "",
        project: null,
        prompt: "fix the bug",
        space: "discord:dm",
        spawnedFromSurface: "discord",
        repo: { owner: "acme", repo: "widgets" },
      });
      expect(task.cwd).toBe("/data/workspace/owner-1/acme-widgets");
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("a task with neither repo nor cwd gets a per-principal scratch folder", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const client = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "cloud", kind: "mock", workspaceRoot: "/data/workspace", adapter: new MockRunnerAdapter() });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("cloud"));
      const task = await dispatcher.dispatch({
        principal: "owner-1",
        runnerId: "cloud",
        cwd: "",
        project: null,
        prompt: "add tofu litter to the cart",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      });
      expect(task.cwd).toMatch(/^\/data\/workspace\/owner-1\/scratch\/[a-z0-9]+-[0-9a-f]{6}$/);
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("selectRunner filters by capability and treats scratch like clone-on-demand", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const browserRunner = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "cloud", kind: "mock", workspaceRoot: "/w", capabilities: ["browser"], adapter: new MockRunnerAdapter() });
    const plain = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "desktop", kind: "mock", workspaceRoot: "/w2", adapter: new MockRunnerAdapter() });
    try {
      await browserRunner.connect(); browserRunner.listen();
      await plain.connect(); plain.listen();
      await waitFor(() => dispatcher.isRunnerLive("cloud") && dispatcher.isRunnerLive("desktop"));
      expect(dispatcher.selectRunner("owner-1", "scratch", { scratch: true })).toHaveProperty("ambiguous");
      expect(dispatcher.selectRunner("owner-1", "scratch", { scratch: true, capability: "browser" })).toEqual({ runnerId: "cloud", viaPref: false });
      expect(dispatcher.listRunners().find((r) => r.runnerId === "cloud")?.capabilities).toEqual(["browser"]);
    } finally {
      browserRunner.close(); plain.close(); dispatcher.stop();
    }
  });

  test("clone-on-demand is rejected on a runner with no workspace root", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "plain-runner",
      kind: "mock",
      projects: ["/srv/repo"],
      adapter: new MockRunnerAdapter(),
    });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("plain-runner"));
      await expect(
        dispatcher.dispatch({
          principal: "owner-1",
          runnerId: "plain-runner",
          cwd: "",
          project: null,
          prompt: "go",
          space: "discord:dm",
          spawnedFromSurface: "discord",
          repo: { owner: "acme", repo: "widgets" },
        }),
      ).rejects.toThrow(/does not support clone-on-demand/);
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("selectRunner: sole eligible auto-picks; ambiguous asks; saved pref resolves", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    const a = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "cloud", kind: "mock", workspaceRoot: "/w", adapter: new MockRunnerAdapter() });
    const b = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "desktop", kind: "mock", workspaceRoot: "/w2", adapter: new MockRunnerAdapter() });
    try {
      await a.connect(); a.listen();
      await b.connect(); b.listen();
      await waitFor(() => dispatcher.isRunnerLive("cloud") && dispatcher.isRunnerLive("desktop"));

      const repo = { owner: "acme", repo: "widgets" };
      // Both declare a workspace → both eligible for a clone-on-demand repo → ambiguous.
      const first = dispatcher.selectRunner("owner-1", "acme/widgets", { repo });
      expect(first).toHaveProperty("ambiguous");
      expect((first as { ambiguous: string[] }).ambiguous.sort()).toEqual(["cloud", "desktop"]);

      // After recording a choice, it resolves to that runner without asking.
      dispatcher.recordRoutingChoice("owner-1", "acme/widgets", "desktop");
      expect(dispatcher.selectRunner("owner-1", "acme/widgets", { repo })).toEqual({ runnerId: "desktop", viaPref: true });

      // A different principal has no saved pref → still ambiguous (pref is per principal).
      expect(dispatcher.selectRunner("owner-2", "acme/widgets", { repo })).toHaveProperty("ambiguous");
    } finally {
      a.close(); b.close(); dispatcher.stop();
    }
  });

  test("selectRunner: none eligible when no runner can service the request", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();
    // A runner with a declared project but no workspace root → cannot clone-on-demand.
    const c = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "plain", kind: "mock", projects: ["/srv/x"], adapter: new MockRunnerAdapter() });
    try {
      await c.connect(); c.listen();
      await waitFor(() => dispatcher.isRunnerLive("plain"));
      expect(dispatcher.selectRunner("owner-1", "acme/widgets", { repo: { owner: "acme", repo: "widgets" } })).toEqual({ none: true });
      // But it IS eligible for an in-project cwd.
      expect(dispatcher.selectRunner("owner-1", "/srv/x", { cwd: "/srv/x/sub" })).toEqual({ runnerId: "plain", viaPref: false });
    } finally {
      c.close(); dispatcher.stop();
    }
  });

  test("e2e dispatch via the mock runner: registry row goes running -> done, summary persisted", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();

    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "mock-runner-1",
      kind: "mock",
      adapter: new MockRunnerAdapter(),
    });

    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("mock-runner-1"));
      expect(dispatcher.isRunnerLive("mock-runner-1")).toBe(true);

      const task = await dispatcher.dispatch({
        principal: "owner-1",
        runnerId: "mock-runner-1",
        cwd: "/tmp",
        project: "sushii-agent",
        prompt: "do the thing",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      });

      expect(task.status).toBe("running");
      expect(task.nativeSessionId).toBe(`mock-${task.id}`);
      expect(dispatcher.listRunning("owner-1").map((t) => t.id)).toEqual([task.id]);

      await waitFor(() => dispatcher.readTask(task.id)?.status === "done");

      const finalRow = dispatcher.readTask(task.id);
      expect(finalRow?.status).toBe("done");
      expect(finalRow?.summary).toBe("mock task complete");
      expect(dispatcher.listRunning("owner-1")).toEqual([]);
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("drops an event whose reporting runner does not own the task", () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    const updateStatusSpy = spyOn(registry, "updateStatus");
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-real",
        project: null,
        cwd: null,
        nativeSessionId: null,
        resumeCursor: null,
        status: "running",
        statusReason: null,
        summary: null,
        spawnedFromSurface: "discord",
        threadRefs: [],
      });

      // A runner other than the one dispatch() recorded on the task must not be able to move it.
      dispatcher.server["options"].onEvent("runner-imposter", { kind: "status", taskId: row.id, status: "done" });

      expect(updateStatusSpy).not.toHaveBeenCalled();
      expect(registry.get(row.id)?.status).toBe("running");
    } finally {
      dispatcher.stop();
    }
  });

  test("dispatch failure does not clobber an already-applied terminal status", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      spyOn(dispatcher.server, "start").mockImplementation(async (_runnerId: string, params: { taskId: string }) => {
        // Simulate an onEvent race: the runner reports "done" before start()'s own promise settles.
        registry.updateStatus(params.taskId, "done", "finished before start resolved");
        throw new Error("start failed after done");
      });

      await expect(
        dispatcher.dispatch({
          principal: "owner-1",
          runnerId: "runner-x",
          cwd: "/tmp",
          project: null,
          prompt: "do it",
          space: "discord:dm",
          spawnedFromSurface: "discord",
        }),
      ).rejects.toThrow("start failed after done");

      const [task] = registry.listByPrincipal("owner-1");
      expect(task?.status).toBe("done");
      expect(task?.statusReason).toBe("finished before start resolved");
    } finally {
      dispatcher.stop();
    }
  });

  test("readTask scopes by principal when given, defense-in-depth symmetric with dispatch()", () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    const row = registry.create({
      createdBy: "owner-1",
      runnerId: "runner-x",
      project: null,
      cwd: null,
      nativeSessionId: null,
      resumeCursor: null,
      status: "running",
      statusReason: null,
      summary: null,
      spawnedFromSurface: "discord",
      threadRefs: [],
    });

    expect(dispatcher.readTask(row.id)).toEqual(row);
    expect(dispatcher.readTask(row.id, "owner-1")).toEqual(row);
    expect(dispatcher.readTask(row.id, "someone-else")).toBeUndefined();
  });

  test("dedupes a repeated (taskId,status) pair but still applies a legitimate revisit", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    const updateStatusSpy = spyOn(registry, "updateStatus");

    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "mock-runner-2",
      kind: "mock",
      adapter: new MockRunnerAdapter(),
    });

    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("mock-runner-2"));

      const task = await dispatcher.dispatch({
        principal: "owner-1",
        runnerId: "mock-runner-2",
        cwd: "/tmp",
        project: null,
        prompt: "do the thing",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      });

      await waitFor(() => dispatcher.readTask(task.id)?.status === "done");
      const callsAfterFirstDone = updateStatusSpy.mock.calls.length;

      // The wire path (server.options.onEvent), not a private-method reach: a duplicate "done"
      // arriving a second time must be dropped rather than re-applied.
      dispatcher.server["options"].onEvent("mock-runner-2", { kind: "status", taskId: task.id, status: "done" });
      expect(updateStatusSpy.mock.calls.length).toBe(callsAfterFirstDone);
      expect(dispatcher.readTask(task.id)?.status).toBe("done");

      // A legitimate revisit of an already-seen status (e.g. a resumed task going idle ->
      // running again) must still be applied, not silently dropped forever.
      dispatcher.server["options"].onEvent("mock-runner-2", { kind: "status", taskId: task.id, status: "running" });
      expect(updateStatusSpy.mock.calls.length).toBe(callsAfterFirstDone + 1);
      expect(dispatcher.readTask(task.id)?.status).toBe("running");
    } finally {
      client.close();
      dispatcher.stop();
    }
  });
});

describe("Dispatcher.resume", () => {
  test("resume is authz-gated first — denied before touching the registry", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => false);
    dispatcher.listen();
    try {
      await expect(
        dispatcher.resume({ principal: "someone", taskId: "task-x", prompt: "continue", space: "discord:dm" }),
      ).rejects.toBeInstanceOf(AuthzError);
    } finally {
      dispatcher.stop();
    }
  });

  test("resume is denied for a principal that does not own the task (even though authz passed)", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-x",
        project: null,
        cwd: null,
        nativeSessionId: "native-1",
        resumeCursor: null,
        status: "done",
        statusReason: null,
        summary: "done",
        spawnedFromSurface: "discord",
        threadRefs: [],
      });
      await expect(
        dispatcher.resume({ principal: "someone-else", taskId: row.id, prompt: "continue", space: "discord:dm" }),
      ).rejects.toBeInstanceOf(AuthzError);
    } finally {
      dispatcher.stop();
    }
  });

  test("resume rejects a task with no native session to resume", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-x",
        project: null,
        cwd: null,
        nativeSessionId: null,
        resumeCursor: null,
        status: "failed",
        statusReason: "boom",
        summary: null,
        spawnedFromSurface: "discord",
        threadRefs: [],
      });
      await expect(
        dispatcher.resume({ principal: "owner-1", taskId: row.id, prompt: "continue", space: "discord:dm" }),
      ).rejects.toThrow(/no native session/);
    } finally {
      dispatcher.stop();
    }
  });

  test("resume rejects when the owning runner is not connected", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-offline",
        project: null,
        cwd: null,
        nativeSessionId: "native-1",
        resumeCursor: null,
        status: "done",
        statusReason: null,
        summary: "done",
        spawnedFromSurface: "discord",
        threadRefs: [],
      });
      await expect(
        dispatcher.resume({ principal: "owner-1", taskId: row.id, prompt: "continue", space: "discord:dm" }),
      ).rejects.toThrow(/not connected/);
    } finally {
      dispatcher.stop();
    }
  });

  test("e2e resume via the mock runner: sends session/resume and the task goes idle -> done again", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => true);
    dispatcher.listen();

    const client = new OrchestrationClient({
      url: dispatcher.server.url,
      runnerId: "mock-runner-resume",
      kind: "mock",
      adapter: new MockRunnerAdapter(),
    });

    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("mock-runner-resume"));

      const task = await dispatcher.dispatch({
        principal: "owner-1",
        runnerId: "mock-runner-resume",
        cwd: "/tmp",
        project: null,
        prompt: "do the thing",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      });
      await waitFor(() => dispatcher.readTask(task.id)?.status === "done");

      const resumed = await dispatcher.resume({ principal: "owner-1", taskId: task.id, prompt: "keep going", space: "discord:dm" });
      expect(resumed.id).toBe(task.id);
      await waitFor(() => dispatcher.readTask(task.id)?.status === "done");
      expect(dispatcher.readTask(task.id)?.status).toBe("done");
    } finally {
      client.close();
      dispatcher.stop();
    }
  });
});

describe("Dispatcher.onTaskSettled", () => {
  test("fires once with the final row when a task goes done, and not on non-settling transitions", () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-real",
        project: null,
        cwd: null,
        nativeSessionId: null,
        resumeCursor: null,
        status: "running",
        statusReason: null,
        summary: null,
        spawnedFromSurface: "discord",
        threadRefs: [],
      });

      const seen: unknown[] = [];
      dispatcher.onTaskSettled((task) => seen.push(task));

      dispatcher.server["options"].onEvent("runner-real", { kind: "progress", taskId: row.id, note: "working" });
      expect(seen).toHaveLength(0);

      dispatcher.server["options"].onEvent("runner-real", { kind: "handback", taskId: row.id, summary: "recap" });
      dispatcher.server["options"].onEvent("runner-real", { kind: "status", taskId: row.id, status: "done" });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: row.id, status: "done", summary: "recap" });
    } finally {
      dispatcher.stop();
    }
  });

  test("fires on idle too — a successful turn resting (awaiting reply) settles same as done/failed", () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-real",
        project: null,
        cwd: null,
        nativeSessionId: null,
        resumeCursor: null,
        status: "running",
        statusReason: null,
        summary: null,
        spawnedFromSurface: "discord",
        threadRefs: [],
      });

      const seen: unknown[] = [];
      dispatcher.onTaskSettled((task) => seen.push(task));

      dispatcher.server["options"].onEvent("runner-real", { kind: "handback", taskId: row.id, summary: "turn recap" });
      dispatcher.server["options"].onEvent("runner-real", { kind: "status", taskId: row.id, status: "idle" });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: row.id, status: "idle", summary: "turn recap" });
      // Still resumable — an idle-settled task must stay in listRunning, not drop out like done/failed.
      expect(dispatcher.listRunning("owner-1").map((t) => t.id)).toEqual([row.id]);
    } finally {
      dispatcher.stop();
    }
  });

  test("fires on failed too, and a listener that throws does not break event handling", () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    try {
      const row = registry.create({
        createdBy: "owner-1",
        runnerId: "runner-real",
        project: null,
        cwd: null,
        nativeSessionId: null,
        resumeCursor: null,
        status: "running",
        statusReason: null,
        summary: null,
        spawnedFromSurface: "discord",
        threadRefs: [],
      });

      const seen: unknown[] = [];
      dispatcher.onTaskSettled(() => { throw new Error("listener boom"); });
      dispatcher.onTaskSettled((task) => seen.push(task));

      dispatcher.server["options"].onEvent("runner-real", { kind: "status", taskId: row.id, status: "failed", reason: "oops" });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: row.id, status: "failed", statusReason: "oops" });
    } finally {
      dispatcher.stop();
    }
  });

  test("steer injects live when the runner delivers — no resume, status unchanged", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    const adapter = new MockRunnerAdapter();
    adapter.steerDelivers = true; // simulate Pi's live mid-run inject
    const client = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "r1", kind: "mock", projects: ["/tmp"], adapter });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("r1"));
      const task = await dispatcher.dispatch({
        principal: "owner",
        runnerId: "r1",
        cwd: "/tmp/x",
        project: null,
        prompt: "go",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      });
      await waitFor(() => registry.get(task.id)?.status === "done");

      const steered = await dispatcher.steer({ principal: "owner", taskId: task.id, text: "focus on the parser", space: "discord:dm" });
      expect(adapter.lastSteer).toEqual({ taskId: task.id, text: "focus on the parser" });
      expect(steered.status).toBe("done"); // delivered live → NOT resumed (a resume would flip it to running)
    } finally {
      client.close();
      dispatcher.stop();
    }
  });

  test("haltTask + steer are authz-gated", async () => {
    const dispatcher = new Dispatcher(testRegistry(), () => false);
    dispatcher.listen();
    try {
      await expect(dispatcher.haltTask({ principal: "x", taskId: "t", space: "s" })).rejects.toBeInstanceOf(AuthzError);
      await expect(dispatcher.steer({ principal: "x", taskId: "t", space: "s", text: "go" })).rejects.toBeInstanceOf(AuthzError);
    } finally {
      dispatcher.stop();
    }
  });

  test("haltTask stops a task resumable (idle); discard marks it failed and tells the runner to discard", async () => {
    const registry = testRegistry();
    const dispatcher = new Dispatcher(registry, () => true);
    dispatcher.listen();
    const adapter = new MockRunnerAdapter();
    const client = new OrchestrationClient({ url: dispatcher.server.url, runnerId: "r1", kind: "mock", projects: ["/tmp"], adapter });
    try {
      await client.connect();
      client.listen();
      await waitFor(() => dispatcher.isRunnerLive("r1"));
      const task = await dispatcher.dispatch({
        principal: "owner",
        runnerId: "r1",
        cwd: "/tmp/x",
        project: null,
        prompt: "go",
        space: "discord:dm",
        spawnedFromSurface: "discord",
      });
      await waitFor(() => registry.get(task.id)?.status === "done"); // let the mock run settle first

      const stopped = await dispatcher.haltTask({ principal: "owner", taskId: task.id, space: "discord:dm" });
      expect(stopped.status).toBe("idle"); // resumable
      expect(stopped.statusReason).toBe("stopped by user");
      expect(adapter.lastStop).toEqual({ taskId: task.id, discard: false });

      const discarded = await dispatcher.haltTask({ principal: "owner", taskId: task.id, space: "discord:dm", discard: true });
      expect(discarded.status).toBe("failed"); // terminal
      expect(adapter.lastStop).toEqual({ taskId: task.id, discard: true });
    } finally {
      client.close();
      dispatcher.stop();
    }
  });
});
