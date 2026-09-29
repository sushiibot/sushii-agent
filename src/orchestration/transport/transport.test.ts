import { describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { config } from "../../config.ts";
import { ORCH_CLOSE, type RunnerAdapter, type RunnerEvent } from "../contracts.ts";
import { MockRunnerAdapter } from "../mockRunner.ts";
import { ownerPrincipalId } from "../principals.ts";
import { OrchestrationClient } from "./client.ts";
import { DEFAULT_OWNER_PRINCIPAL_ID, OrchestrationServer, defaultSecretGrants, grantForSecret, type SecretGrant } from "./server.ts";

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

  test("ordinary follow-up has its own RPC path and does not call steer", async () => {
    class SeparateMessagesRunner extends MockRunnerAdapter {
      steers = 0;
      followUps: string[] = [];
      override async steer(input: { taskId: string; text: string }): Promise<{ delivered: boolean }> {
        this.steers++;
        return super.steer(input);
      }
      override async followUp(input: { taskId: string; text: string }): Promise<{ delivered: boolean }> {
        this.followUps.push(input.text);
        return { delivered: true };
      }
    }
    const server = new OrchestrationServer({ onEvent: () => {} });
    server.listen();
    const adapter = new SeparateMessagesRunner();
    const client = new OrchestrationClient({ url: server.url, runnerId: "message-runner", kind: "mock", adapter });
    try {
      await client.connect(); client.listen();
      expect(await server.followUp("message-runner", { taskId: "task-1", text: "normal reply" })).toEqual({ delivered: true });
      expect(adapter.followUps).toEqual(["normal reply"]);
      expect(adapter.steers).toBe(0);
    } finally {
      client.close(); server.stop();
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
      async steer(): Promise<{ delivered: boolean }> {
        return { delivered: false };
      }
      async followUp(): Promise<{ delivered: boolean }> {
        return { delivered: false };
      }
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

  test("ask and browser events pass wire validation, and browser watch reaches the adapter", async () => {
    const events: RunnerEvent[] = [];
    const watched: { taskId: string; watch: boolean }[] = [];
    class BrowserAdapter extends MockRunnerAdapter {
      override async stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void> {
        onEvent({ kind: "ask", taskId, askId: "a1", question: "Which?", choices: ["x", "y"] });
        onEvent({ kind: "browser", taskId, connected: true, frame: "AAAA", width: 10, height: 5 });
      }
      async watchBrowser(input: { taskId: string; watch: boolean }): Promise<{ supported: boolean }> {
        watched.push(input);
        return { supported: true };
      }
    }
    const server = new OrchestrationServer({ onEvent: (_r, e) => events.push(e) });
    server.listen();
    const client = new OrchestrationClient({ url: server.url, runnerId: "r-browser", kind: "mock", adapter: new BrowserAdapter() });
    try {
      await client.connect();
      client.listen();
      await server.start("r-browser", { taskId: "t-b", cwd: "/tmp", prompt: "p" });
      const deadline = Date.now() + 2000;
      while (events.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(events.map((e) => e.kind)).toEqual(["ask", "browser"]);
      expect(events[1]).toMatchObject({ kind: "browser", connected: true, frame: "AAAA" });

      expect(await server.watchBrowser("r-browser", { taskId: "t-b", watch: true })).toEqual({ supported: true });
      expect(watched).toEqual([{ taskId: "t-b", watch: true }]);
    } finally {
      client.close();
      server.stop();
    }
  });

  test("a runner without browser support answers supported:false", async () => {
    const server = new OrchestrationServer({ onEvent: () => {} });
    server.listen();
    const client = new OrchestrationClient({ url: server.url, runnerId: "r-plain", kind: "mock", adapter: new MockRunnerAdapter() });
    try {
      await client.connect();
      client.listen();
      expect(await server.watchBrowser("r-plain", { taskId: "t", watch: true })).toEqual({ supported: false });
    } finally {
      client.close();
      server.stop();
    }
  });
});

describe("runner registration auth", () => {
  const SECRET = "s3cret-value";
  const PRINCIPAL = "drk";
  const BOTH_ROLES: Record<string, SecretGrant> = { [SECRET]: { principalId: PRINCIPAL, roles: ["workspace", "task-runner"] } };

  function authServer(secretGrants: Record<string, SecretGrant> = BOTH_ROLES) {
    const registered: string[] = [];
    const server = new OrchestrationServer({
      onEvent: () => {},
      onRegister: (runnerId) => registered.push(runnerId),
      secretGrants,
    });
    server.listen();
    return { server, registered };
  }

  // Registers over a raw socket and resolves with the ack, or with the close code if the server hangs up.
  function rawRegister(
    url: string,
    params: Record<string, unknown>,
  ): Promise<{ ws: WebSocket; ok: boolean; closeCode: number | null; closeReason: string | null }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let ok = false;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runner/register", params: { kind: "mock", ...params } }));
      });
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data.toString());
        if (msg.id === 1 && msg.result) {
          ok = true;
          resolve({ ws, ok, closeCode: null, closeReason: null });
        }
      });
      ws.addEventListener("close", (event) => resolve({ ws, ok, closeCode: event.code, closeReason: event.reason }));
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
  }

  function waitForClose(ws: WebSocket): Promise<number> {
    if (ws.readyState === ws.CLOSED) return Promise.resolve(-1);
    return new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  }

  test("correct secret is accepted and the connection records role/principal/version", async () => {
    const { server, registered } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "r1", secret: SECRET });
      expect(r.ok).toBe(true);
      expect(registered).toEqual(["r1"]);
      expect(server.getConnection("r1")).toEqual({
        runnerId: "r1",
        role: "task-runner",
        principalId: PRINCIPAL,
        protocolVersion: 1,
        state: undefined,
      });
      r.ws.close();
    } finally {
      server.stop();
    }
  });

  test("OrchestrationClient sends its secret, role and protocolVersion", async () => {
    const { server } = authServer();
    const client = new OrchestrationClient({
      url: server.url,
      runnerId: "client-ws",
      kind: "mock",
      role: "workspace",
      secret: SECRET,
      state: "idle",
      adapter: new MockRunnerAdapter(),
    });
    try {
      await client.connect();
      expect(server.getWorkspaceConnection(PRINCIPAL)).toMatchObject({ runnerId: "client-ws", role: "workspace", state: "idle" });
    } finally {
      client.close();
      server.stop();
    }
  });

  test("wrong secret → 4401", async () => {
    const { server, registered } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "r1", secret: "nope" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      expect(r.closeReason).toBe("unauthorized");
      expect(registered).toEqual([]);
      expect(server.isConnected("r1")).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("missing secret while one is configured → 4401", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "r1" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
    } finally {
      server.stop();
    }
  });

  test("no secret configured: legacy task runner is accepted", async () => {
    const { server, registered } = authServer({});
    try {
      const r = await rawRegister(server.url, { runnerId: "legacy" });
      expect(r.ok).toBe(true);
      expect(registered).toEqual(["legacy"]);
      expect(server.getConnection("legacy")).toMatchObject({ role: "task-runner", principalId: null, protocolVersion: 1 });
      r.ws.close();
    } finally {
      server.stop();
    }
  });

  test("no secret configured: workspace is always refused with 4401", async () => {
    const { server } = authServer({});
    try {
      const r = await rawRegister(server.url, { runnerId: "ws", role: "workspace", secret: "anything" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("unsupported protocolVersion → 4426", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "r1", secret: SECRET, protocolVersion: 2 });
      expect(r.closeCode).toBe(ORCH_CLOSE.unsupportedVersion);
      expect(r.closeReason).toBe("unsupported protocolVersion");
    } finally {
      server.stop();
    }
  });

  test("asserted principalId that differs from the secret's principal → 4401", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "r1", role: "workspace", secret: SECRET, principalId: "someone-else" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      const ok = await rawRegister(server.url, { runnerId: "r2", role: "workspace", secret: SECRET, principalId: PRINCIPAL });
      expect(ok.ok).toBe(true);
      ok.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a rejected register reusing a live runner's id does not evict it", async () => {
    const { server, registered } = authServer();
    try {
      const live = await rawRegister(server.url, { runnerId: "r1", secret: SECRET });
      expect(live.ok).toBe(true);
      const bad = await rawRegister(server.url, { runnerId: "r1", secret: "wrong" });
      expect(bad.closeCode).toBe(ORCH_CLOSE.unauthorized);
      expect(server.isConnected("r1")).toBe(true);
      expect(live.ws.readyState).toBe(live.ws.OPEN);
      expect(registered).toEqual(["r1"]);
      live.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a second workspace register for the same principal replaces the first", async () => {
    const disconnects: string[] = [];
    const registered: string[] = [];
    const server = new OrchestrationServer({
      onEvent: () => {},
      onRegister: (id) => registered.push(id),
      onDisconnect: (id) => disconnects.push(id),
      secretGrants: BOTH_ROLES,
    });
    server.listen();
    try {
      const first = await rawRegister(server.url, { runnerId: "ws-a", role: "workspace", secret: SECRET });
      expect(first.ok).toBe(true);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("ws-a");
      const firstClosed = waitForClose(first.ws);

      const second = await rawRegister(server.url, { runnerId: "ws-b", role: "workspace", secret: SECRET, state: "streaming" });
      expect(second.ok).toBe(true);
      expect(await firstClosed).toBe(ORCH_CLOSE.replaced);
      // Let the server run the first socket's close handler before re-checking the entry.
      await new Promise((r) => setTimeout(r, 20));
      expect(server.getWorkspaceConnection(PRINCIPAL)).toMatchObject({ runnerId: "ws-b", state: "streaming" });
      // Workspaces stay out of the dispatcher's task-runner lifecycle.
      expect(registered).toEqual([]);
      expect(disconnects).toEqual([]);

      second.ws.close();
      await waitForClose(second.ws);
      await new Promise((r) => setTimeout(r, 20));
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("a workspace re-registering with the same runnerId closes the old socket with 4409", async () => {
    const { server } = authServer();
    try {
      const first = await rawRegister(server.url, { runnerId: "ws", role: "workspace", secret: SECRET });
      expect(first.ok).toBe(true);
      const firstClosed = waitForClose(first.ws);
      const second = await rawRegister(server.url, { runnerId: "ws", role: "workspace", secret: SECRET });
      expect(second.ok).toBe(true);
      expect(await firstClosed).toBe(ORCH_CLOSE.replaced);
      await new Promise((r) => setTimeout(r, 20));
      expect(second.ws.readyState).toBe(second.ws.OPEN);
      expect(server.isConnected("ws")).toBe(true);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("ws");
      second.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a register whose runnerId is live under another role is refused without disturbing the live one", async () => {
    const disconnects: string[] = [];
    const registered: string[] = [];
    const server = new OrchestrationServer({
      onEvent: () => {},
      onRegister: (id) => registered.push(id),
      onDisconnect: (id) => disconnects.push(id),
      secretGrants: BOTH_ROLES,
    });
    server.listen();
    try {
      const runner = await rawRegister(server.url, { runnerId: "r1", secret: SECRET });
      expect(runner.ok).toBe(true);
      const hijack = await rawRegister(server.url, { runnerId: "r1", role: "workspace", secret: SECRET });
      expect(hijack.ok).toBe(false);
      expect(hijack.closeCode).toBe(ORCH_CLOSE.replaced);
      expect(hijack.closeReason).toBe("runnerId in use by another role");
      expect(runner.ws.readyState).toBe(runner.ws.OPEN);
      expect(server.getConnection("r1")?.role).toBe("task-runner");
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
      expect(registered).toEqual(["r1"]);
      expect(disconnects).toEqual([]);
      runner.ws.close();

      const ws = await rawRegister(server.url, { runnerId: "w1", role: "workspace", secret: SECRET });
      expect(ws.ok).toBe(true);
      const clash = await rawRegister(server.url, { runnerId: "w1", secret: SECRET });
      expect(clash.closeCode).toBe(ORCH_CLOSE.replaced);
      expect(server.getConnection("w1")?.role).toBe("workspace");
      expect(registered).toEqual(["r1"]);
      ws.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a malformed register closes the socket", async () => {
    const { server } = authServer();
    try {
      for (const bad of [{ protocolVersion: "2" }, { protocolVersion: null }, { secret: null }, { role: "admin" }]) {
        const r = await rawRegister(server.url, { runnerId: "r1", ...bad });
        expect(r.ok).toBe(false);
        expect(r.closeCode).toBe(1008);
      }
      expect(server.isConnected("r1")).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a second register on an already-registered socket is refused and leaves the first intact", async () => {
    const { server, registered } = authServer();
    try {
      const first = await rawRegister(server.url, { runnerId: "w", role: "workspace", secret: SECRET });
      expect(first.ok).toBe(true);
      const reply = new Promise<{ error?: { message: string } }>((resolve) =>
        first.ws.addEventListener("message", (e) => resolve(JSON.parse(e.data.toString()))),
      );
      first.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "runner/register", params: { kind: "mock", runnerId: "t", secret: SECRET } }));
      expect((await reply).error?.message).toBe("already registered");
      expect(server.isConnected("t")).toBe(false);
      expect(server.getWorkspaceConnection(PRINCIPAL)).toMatchObject({ runnerId: "w", role: "workspace" });
      expect(registered).toEqual([]);
      first.ws.close();
      await waitForClose(first.ws);
      await new Promise((r) => setTimeout(r, 20));
      expect(server.isConnected("w")).toBe(false);
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("grantForSecret compares in constant time and never on unequal lengths", () => {
    const spy = spyOn(crypto, "timingSafeEqual");
    try {
      expect(grantForSecret(BOTH_ROLES, SECRET)).toEqual(BOTH_ROLES[SECRET]!);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(grantForSecret(BOTH_ROLES, "short")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const sameLength = "x".repeat(SECRET.length);
      expect(grantForSecret(BOTH_ROLES, sameLength)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(grantForSecret({}, SECRET)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("defaultSecretGrants binds ORCH_SECRET to workspaces and ORCH_RUNNER_SECRET to task runners", () => {
    const saved = { orchSecret: config.orchSecret, orchRunnerSecret: config.orchRunnerSecret };
    const principalId = ownerPrincipalId() ?? DEFAULT_OWNER_PRINCIPAL_ID;
    try {
      config.orchSecret = undefined;
      config.orchRunnerSecret = undefined;
      expect(defaultSecretGrants()).toEqual({});
      config.orchSecret = SECRET;
      config.orchRunnerSecret = "runner-secret";
      expect(defaultSecretGrants()).toEqual({
        [SECRET]: { principalId, roles: ["workspace"] },
        "runner-secret": { principalId, roles: ["task-runner"] },
      });
    } finally {
      Object.assign(config, saved);
    }
  });

  test("identical ORCH_SECRET and ORCH_RUNNER_SECRET fail closed: no role registers, with or without it", async () => {
    const saved = { orchSecret: config.orchSecret, orchRunnerSecret: config.orchRunnerSecret };
    config.orchSecret = SECRET;
    config.orchRunnerSecret = SECRET;
    const registered: string[] = [];
    const server = new OrchestrationServer({ onEvent: () => {}, onRegister: (id) => registered.push(id) });
    try {
      expect(defaultSecretGrants()).toEqual({});
      server.listen();
      const attempts: Record<string, unknown>[] = [
        { runnerId: "w1", role: "workspace", secret: SECRET },
        { runnerId: "w2", role: "workspace", secret: SECRET, principalId: PRINCIPAL },
        { runnerId: "t1", role: "task-runner", secret: SECRET },
        { runnerId: "t2", role: "task-runner" },
        { runnerId: "t3" },
      ];
      for (const params of attempts) {
        const r = await rawRegister(server.url, params);
        expect(r.ok).toBe(false);
        expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      }
      expect(registered).toEqual([]);
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
      Object.assign(config, saved);
    }
  });

  describe("per-role secrets", () => {
    const WORKSPACE_SECRET = "workspace-secret";
    const RUNNER_SECRET = "runner-secret-x";
    const PER_ROLE: Record<string, SecretGrant> = {
      [WORKSPACE_SECRET]: { principalId: PRINCIPAL, roles: ["workspace"] },
      [RUNNER_SECRET]: { principalId: PRINCIPAL, roles: ["task-runner"] },
    };

    test("the runner secret can't register a workspace", async () => {
      const { server } = authServer(PER_ROLE);
      try {
        const r = await rawRegister(server.url, { runnerId: "ws", role: "workspace", secret: RUNNER_SECRET });
        expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
        expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
        const ok = await rawRegister(server.url, { runnerId: "ws", role: "workspace", secret: WORKSPACE_SECRET });
        expect(ok.ok).toBe(true);
        ok.ws.close();
      } finally {
        server.stop();
      }
    });

    test("the workspace secret can't register a task runner", async () => {
      const { server, registered } = authServer(PER_ROLE);
      try {
        const r = await rawRegister(server.url, { runnerId: "r1", secret: WORKSPACE_SECRET });
        expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
        expect(registered).toEqual([]);
        const ok = await rawRegister(server.url, { runnerId: "r1", secret: RUNNER_SECRET });
        expect(ok.ok).toBe(true);
        expect(server.getConnection("r1")).toMatchObject({ role: "task-runner", principalId: PRINCIPAL });
        ok.ws.close();
      } finally {
        server.stop();
      }
    });

    test("no runner secret configured: task runners register without one, workspaces still need theirs", async () => {
      const { server, registered } = authServer({ [WORKSPACE_SECRET]: { principalId: PRINCIPAL, roles: ["workspace"] } });
      try {
        const legacy = await rawRegister(server.url, { runnerId: "legacy" });
        expect(legacy.ok).toBe(true);
        expect(registered).toEqual(["legacy"]);
        expect(server.getConnection("legacy")).toMatchObject({ role: "task-runner", principalId: null });
        // The workspace secret is still bound to its role, even on the unauthenticated runner path.
        const misuse = await rawRegister(server.url, { runnerId: "r2", secret: WORKSPACE_SECRET });
        expect(misuse.closeCode).toBe(ORCH_CLOSE.unauthorized);
        const noSecretWs = await rawRegister(server.url, { runnerId: "ws", role: "workspace" });
        expect(noSecretWs.closeCode).toBe(ORCH_CLOSE.unauthorized);
        const ws = await rawRegister(server.url, { runnerId: "ws", role: "workspace", secret: WORKSPACE_SECRET });
        expect(ws.ok).toBe(true);
        legacy.ws.close();
        ws.ws.close();
      } finally {
        server.stop();
      }
    });
  });

  test("a workspace socket's session/update never reaches the dispatcher's onEvent", async () => {
    const events: [string, RunnerEvent][] = [];
    const server = new OrchestrationServer({ onEvent: (id, e) => events.push([id, e]), secretGrants: BOTH_ROLES });
    server.listen();
    try {
      const ws = await rawRegister(server.url, { runnerId: "r1", role: "workspace", secret: SECRET });
      expect(ws.ok).toBe(true);
      const update = { kind: "status", taskId: "t1", status: "done" };
      ws.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: update }));
      ws.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/update", params: update }));
      ws.ws.close();
      await waitForClose(ws.ws);

      const runner = await rawRegister(server.url, { runnerId: "r1", secret: SECRET });
      runner.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: update }));
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual([["r1", update as RunnerEvent]]);
      runner.ws.close();
    } finally {
      server.stop();
    }
  });
});

describe("client reconnect loop", () => {
  // A bare server that counts upgrades and answers every register the way `onRegister` says.
  function fakeOrchestrator(onRegister: (ws: import("bun").ServerWebSocket<undefined>, id: unknown) => void) {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("", { status: 426 })),
      websocket: {
        open: () => {
          attempts++;
        },
        message: (ws, raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.method === "runner/register") onRegister(ws, msg.id);
        },
      },
    });
    return { server, url: `ws://localhost:${server.port}`, attempts: () => attempts };
  }

  function runClient(url: string, backoffCapMs: number) {
    const client = new OrchestrationClient({ url, runnerId: "loop", kind: "mock", heartbeatMs: 0, backoffCapMs, adapter: new MockRunnerAdapter() });
    const done = client.run();
    return { client, done };
  }

  test("a 4401 rejection backs off exponentially instead of tight-looping", async () => {
    const orch = fakeOrchestrator((ws, id) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "unauthorized" } }));
      ws.close(ORCH_CLOSE.unauthorized, "unauthorized");
    });
    const { client, done } = runClient(orch.url, 30_000);
    try {
      // Attempts at ~0, 500, 1500 ms; a tight loop would be far more.
      await new Promise((r) => setTimeout(r, 1_200));
      expect(orch.attempts()).toBe(2);
    } finally {
      client.close();
      await done;
      orch.server.stop(true);
    }
  });

  test("a 4409 close after a successful register waits the full backoff cap", async () => {
    const orch = fakeOrchestrator((ws, id) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
      setTimeout(() => ws.close(ORCH_CLOSE.replaced, "replaced by a newer workspace connection"), 10);
    });
    const { client, done } = runClient(orch.url, 1_500);
    try {
      // backoff resets to 500 ms after a successful connect; 4409 must use the 1.5 s cap instead.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(orch.attempts()).toBe(1);
      await new Promise((r) => setTimeout(r, 900));
      expect(orch.attempts()).toBe(2);
    } finally {
      client.close();
      await done;
      orch.server.stop(true);
    }
  });
});
