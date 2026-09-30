import { describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { config } from "../../config.ts";
import { ORCH_CLOSE } from "../contracts.ts";
import { ownerPrincipalId } from "../principals.ts";
import { OrchestrationClient } from "./client.ts";
import { DEFAULT_OWNER_PRINCIPAL_ID, OrchestrationServer, defaultSecretGrants, grantForSecret, type SecretGrant } from "./server.ts";

describe("workspace registration auth", () => {
  const SECRET = "s3cret-value";
  const PRINCIPAL = "drk";
  const GRANTS: Record<string, SecretGrant> = { [SECRET]: { principalId: PRINCIPAL } };

  function authServer(secretGrants: Record<string, SecretGrant> = GRANTS) {
    const registered: string[] = [];
    const server = new OrchestrationServer({ secretGrants });
    server.setWorkspaceHandler({ onRegister: (conn) => registered.push(conn.runnerId) });
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

  const WS = { role: "workspace", secret: SECRET };

  test("correct secret is accepted and the connection records role/principal/version", async () => {
    const { server, registered } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "w1", ...WS });
      expect(r.ok).toBe(true);
      expect(registered).toEqual(["w1"]);
      expect(server.getWorkspaceConnection(PRINCIPAL)).toEqual({
        runnerId: "w1",
        role: "workspace",
        principalId: PRINCIPAL,
        protocolVersion: 1,
        state: undefined,
      });
      r.ws.close();
    } finally {
      server.stop();
    }
  });

  test("OrchestrationClient sends its secret, role and state", async () => {
    const { server } = authServer();
    const client = new OrchestrationClient({ url: server.url, runnerId: "client-ws", kind: "mock", secret: SECRET, state: "idle" });
    try {
      await client.connect();
      expect(server.getWorkspaceConnection(PRINCIPAL)).toMatchObject({ runnerId: "client-ws", role: "workspace", state: "idle" });
    } finally {
      client.close();
      server.stop();
    }
  });

  test("an older client's task-runner fields are ignored, not rejected", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "w1", ...WS, projects: [], workspaceRoot: null, location: "workspace", capabilities: [], ownerOnly: true });
      expect(r.ok).toBe(true);
      r.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a task-runner register, or one with no role, is refused even with the right secret", async () => {
    const { server, registered } = authServer();
    try {
      for (const params of [{ runnerId: "t1", role: "task-runner", secret: SECRET }, { runnerId: "t2", secret: SECRET }]) {
        const r = await rawRegister(server.url, params);
        expect(r.ok).toBe(false);
        expect(r.closeCode).toBe(1008);
      }
      expect(registered).toEqual([]);
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("wrong secret → 4401", async () => {
    const { server, registered } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "w1", role: "workspace", secret: "nope" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      expect(r.closeReason).toBe("unauthorized");
      expect(registered).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("missing secret → 4401", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "w1", role: "workspace" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
    } finally {
      server.stop();
    }
  });

  test("no secret configured: every workspace is refused with 4401", async () => {
    const { server } = authServer({});
    try {
      for (const params of [{ runnerId: "ws", role: "workspace", secret: "anything" }, { runnerId: "ws", role: "workspace" }]) {
        const r = await rawRegister(server.url, params);
        expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      }
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("unsupported protocolVersion → 4426", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "w1", ...WS, protocolVersion: 2 });
      expect(r.closeCode).toBe(ORCH_CLOSE.unsupportedVersion);
      expect(r.closeReason).toBe("unsupported protocolVersion");
    } finally {
      server.stop();
    }
  });

  test("asserted principalId that differs from the secret's principal → 4401", async () => {
    const { server } = authServer();
    try {
      const r = await rawRegister(server.url, { runnerId: "r1", ...WS, principalId: "someone-else" });
      expect(r.closeCode).toBe(ORCH_CLOSE.unauthorized);
      const ok = await rawRegister(server.url, { runnerId: "r2", ...WS, principalId: PRINCIPAL });
      expect(ok.ok).toBe(true);
      ok.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a rejected register reusing a live workspace's id does not evict it", async () => {
    const { server, registered } = authServer();
    try {
      const live = await rawRegister(server.url, { runnerId: "w1", ...WS });
      expect(live.ok).toBe(true);
      const bad = await rawRegister(server.url, { runnerId: "w1", role: "workspace", secret: "wrong" });
      expect(bad.closeCode).toBe(ORCH_CLOSE.unauthorized);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("w1");
      expect(live.ws.readyState).toBe(live.ws.OPEN);
      expect(registered).toEqual(["w1"]);
      live.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a second workspace register for the same principal replaces the first", async () => {
    const { server } = authServer();
    try {
      const first = await rawRegister(server.url, { runnerId: "ws-a", ...WS });
      expect(first.ok).toBe(true);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("ws-a");
      const firstClosed = waitForClose(first.ws);

      const second = await rawRegister(server.url, { runnerId: "ws-b", ...WS, state: "streaming" });
      expect(second.ok).toBe(true);
      expect(await firstClosed).toBe(ORCH_CLOSE.replaced);
      // Let the server run the first socket's close handler before re-checking the entry.
      await new Promise((r) => setTimeout(r, 20));
      expect(server.getWorkspaceConnection(PRINCIPAL)).toMatchObject({ runnerId: "ws-b", state: "streaming" });

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
      const first = await rawRegister(server.url, { runnerId: "ws", ...WS });
      expect(first.ok).toBe(true);
      const firstClosed = waitForClose(first.ws);
      const second = await rawRegister(server.url, { runnerId: "ws", ...WS });
      expect(second.ok).toBe(true);
      expect(await firstClosed).toBe(ORCH_CLOSE.replaced);
      await new Promise((r) => setTimeout(r, 20));
      expect(second.ws.readyState).toBe(second.ws.OPEN);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("ws");
      second.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a register whose runnerId is live under another principal is refused without disturbing the live one", async () => {
    const OTHER = "other-secret";
    const { server } = authServer({ ...GRANTS, [OTHER]: { principalId: "someone" } });
    try {
      const live = await rawRegister(server.url, { runnerId: "w1", ...WS });
      expect(live.ok).toBe(true);
      const clash = await rawRegister(server.url, { runnerId: "w1", role: "workspace", secret: OTHER });
      expect(clash.ok).toBe(false);
      expect(clash.closeCode).toBe(ORCH_CLOSE.replaced);
      expect(clash.closeReason).toBe("runnerId in use by another principal");
      expect(live.ws.readyState).toBe(live.ws.OPEN);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("w1");
      expect(server.getWorkspaceConnection("someone")).toBeUndefined();
      live.ws.close();
    } finally {
      server.stop();
    }
  });

  test("a malformed register closes the socket", async () => {
    const { server } = authServer();
    try {
      for (const bad of [{ protocolVersion: "2" }, { protocolVersion: null }, { secret: null }, { role: "admin" }]) {
        const r = await rawRegister(server.url, { runnerId: "w1", ...WS, ...bad });
        expect(r.ok).toBe(false);
        expect(r.closeCode).toBe(1008);
      }
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("a second register on an already-registered socket is refused and leaves the first intact", async () => {
    const { server, registered } = authServer();
    try {
      const first = await rawRegister(server.url, { runnerId: "w", ...WS });
      expect(first.ok).toBe(true);
      const reply = new Promise<{ error?: { message: string } }>((resolve) =>
        first.ws.addEventListener("message", (e) => resolve(JSON.parse(e.data.toString()))),
      );
      first.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "runner/register", params: { kind: "mock", runnerId: "t", ...WS } }));
      expect((await reply).error?.message).toBe("already registered");
      expect(server.getWorkspaceConnection(PRINCIPAL)).toMatchObject({ runnerId: "w", role: "workspace" });
      expect(registered).toEqual(["w"]);
      first.ws.close();
      await waitForClose(first.ws);
      await new Promise((r) => setTimeout(r, 20));
      expect(server.getWorkspaceConnection(PRINCIPAL)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("grantForSecret compares in constant time and never on unequal lengths", () => {
    const spy = spyOn(crypto, "timingSafeEqual");
    try {
      expect(grantForSecret(GRANTS, SECRET)).toEqual(GRANTS[SECRET]!);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(grantForSecret(GRANTS, "short")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const sameLength = "x".repeat(SECRET.length);
      expect(grantForSecret(GRANTS, sameLength)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(grantForSecret({}, SECRET)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("defaultSecretGrants binds ORCH_SECRET to the owner principal", () => {
    const saved = config.orchSecret;
    const principalId = ownerPrincipalId() ?? DEFAULT_OWNER_PRINCIPAL_ID;
    try {
      config.orchSecret = undefined;
      expect(defaultSecretGrants()).toEqual({});
      config.orchSecret = SECRET;
      expect(defaultSecretGrants()).toEqual({ [SECRET]: { principalId } });
    } finally {
      config.orchSecret = saved;
    }
  });

  test("a workspace's session/update notification goes to its notification handler, nowhere else", async () => {
    const notified: string[] = [];
    const server = new OrchestrationServer({ secretGrants: GRANTS });
    server.setWorkspaceHandler({ onNotification: (_conn, method) => notified.push(method) });
    server.listen();
    try {
      const ws = await rawRegister(server.url, { runnerId: "w1", ...WS });
      expect(ws.ok).toBe(true);
      ws.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { kind: "status", taskId: "t1", status: "done" } }));
      await new Promise((r) => setTimeout(r, 50));
      expect(notified).toEqual(["session/update"]);
      ws.ws.close();
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
    const client = new OrchestrationClient({ url, runnerId: "loop", kind: "mock", heartbeatMs: 0, backoffCapMs });
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
