import { describe, expect, test } from "bun:test";
import { OrchestrationClient } from "./client.ts";
import {
  MethodNotFoundError,
  OrchestrationServer,
  RpcConnectionClosedError,
  RpcErrorReply,
  RpcTimeoutError,
  WorkspaceNotConnectedError,
  mayHaveBeenAccepted,
  type ConnectionInfo,
  type SecretGrant,
} from "./server.ts";
import { RPC_METHODS } from "../contracts.ts";

const SECRET = "ws-secret";
const PRINCIPAL = "drk";
const GRANTS: Record<string, SecretGrant> = { [SECRET]: { principalId: PRINCIPAL, roles: ["workspace"] } };

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

function workspaceClient(url: string, handlers: Record<string, (p: unknown) => Promise<unknown>> = {}, runnerId = "workspace-drk") {
  return new OrchestrationClient({ url, runnerId, kind: "pi-workspace", role: "workspace", secret: SECRET, principalId: PRINCIPAL, state: "idle", handlers, heartbeatMs: 0 });
}

describe("workspace handler routing", () => {
  test("register hook fires after the ok, and requests/notifications reach the handler", async () => {
    const server = new OrchestrationServer({ onEvent: () => {}, secretGrants: GRANTS });
    const registered: ConnectionInfo[] = [];
    const notes: Array<{ method: string; params: unknown }> = [];
    server.setWorkspaceHandler({
      onRegister: (conn) => registered.push(conn),
      onRequest: async (_conn, method, params) => {
        if (method === RPC_METHODS.chatDeliver) return { got: (params as { outboxId: string }).outboxId };
        throw new MethodNotFoundError(`method not found: ${method}`);
      },
      onNotification: (_conn, method, params) => notes.push({ method, params }),
    });
    server.listen();
    const client = workspaceClient(server.url);
    try {
      await client.connect();
      client.listen();
      expect(registered.map((c) => [c.runnerId, c.principalId, c.state])).toEqual([["workspace-drk", PRINCIPAL, "idle"]]);

      expect(await client.request(RPC_METHODS.chatDeliver, { outboxId: "o1" })).toEqual({ got: "o1" });
      await expect(client.request("chat/unknown", {})).rejects.toThrow("method not found");

      client.notify(RPC_METHODS.chatEvent, { turnId: "t" });
      client.notify(RPC_METHODS.heartbeat, {});
      await until(() => notes.length > 0);
      expect(notes).toEqual([{ method: RPC_METHODS.chatEvent, params: { turnId: "t" } }]);
    } finally {
      client.close();
      server.stop();
    }
  });

  test("a request with no handler installed gets an error reply rather than hanging", async () => {
    const server = new OrchestrationServer({ onEvent: () => {}, secretGrants: GRANTS });
    server.listen();
    const client = workspaceClient(server.url);
    try {
      await client.connect();
      client.listen();
      await expect(client.request(RPC_METHODS.chatDeliver, {})).rejects.toThrow("method not found");
    } finally {
      client.close();
      server.stop();
    }
  });

  test("requestWorkspace reaches the workspace's handlers and times out without leaking", async () => {
    const server = new OrchestrationServer({ onEvent: () => {}, secretGrants: GRANTS });
    server.listen();
    const client = workspaceClient(server.url, {
      [RPC_METHODS.chatAbort]: async () => ({ aborted: true }),
      [RPC_METHODS.chatNew]: () => new Promise(() => {}),
    });
    try {
      await client.connect();
      client.listen();
      expect(await server.requestWorkspace(PRINCIPAL, RPC_METHODS.chatAbort, { principalId: PRINCIPAL })).toEqual({ aborted: true });
      await expect(server.requestWorkspace(PRINCIPAL, RPC_METHODS.chatNew, { principalId: PRINCIPAL }, 30)).rejects.toThrow("timed out");
      await expect(server.requestWorkspace("nobody", RPC_METHODS.chatAbort, {})).rejects.toThrow("not connected");
    } finally {
      client.close();
      server.stop();
    }
  });

  test("request failures are typed by whether the workspace may still have accepted the request", async () => {
    const server = new OrchestrationServer({ onEvent: () => {}, secretGrants: GRANTS });
    server.listen();
    const client = workspaceClient(server.url, {
      [RPC_METHODS.chatMessage]: async () => {
        throw new Error("personal session not started");
      },
      [RPC_METHODS.chatNew]: () => new Promise(() => {}),
    });
    const failure = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);
    try {
      await client.connect();
      client.listen();
      const refused = await failure(server.requestWorkspace(PRINCIPAL, RPC_METHODS.chatMessage, {}));
      expect(refused).toBeInstanceOf(RpcErrorReply);
      expect(mayHaveBeenAccepted(refused)).toBe(false);

      const timedOut = await failure(server.requestWorkspace(PRINCIPAL, RPC_METHODS.chatNew, {}, 30));
      expect(timedOut).toBeInstanceOf(RpcTimeoutError);
      expect(mayHaveBeenAccepted(timedOut)).toBe(true);

      const absent = await failure(server.requestWorkspace("nobody", RPC_METHODS.chatMessage, {}));
      expect(absent).toBeInstanceOf(WorkspaceNotConnectedError);
      expect(mayHaveBeenAccepted(absent)).toBe(false);

      const inFlight = failure(server.requestWorkspace(PRINCIPAL, RPC_METHODS.chatNew, {}));
      client.close();
      const closed = await inFlight;
      expect(closed).toBeInstanceOf(RpcConnectionClosedError);
      expect(mayHaveBeenAccepted(closed)).toBe(true);
    } finally {
      client.close();
      server.stop();
    }
  });

  test("disconnect fires for the live workspace, not for one that was replaced", async () => {
    const server = new OrchestrationServer({ onEvent: () => {}, secretGrants: GRANTS });
    const disconnected: string[] = [];
    const registered: string[] = [];
    server.setWorkspaceHandler({
      onRegister: (conn) => registered.push(conn.runnerId),
      onDisconnect: (conn) => disconnected.push(conn.runnerId),
    });
    server.listen();
    const first = workspaceClient(server.url, {}, "ws-a");
    const second = workspaceClient(server.url, {}, "ws-b");
    try {
      await first.connect();
      await second.connect();
      await until(() => !first.connected);
      await new Promise((r) => setTimeout(r, 20));
      expect(disconnected).toEqual([]);
      expect(server.getWorkspaceConnection(PRINCIPAL)?.runnerId).toBe("ws-b");

      second.close();
      await until(() => disconnected.length > 0);
      expect(disconnected).toEqual(["ws-b"]);
      expect(registered).toEqual(["ws-a", "ws-b"]);
    } finally {
      first.close();
      second.close();
      server.stop();
    }
  });
});
