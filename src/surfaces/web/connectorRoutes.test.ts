import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CONNECTOR_ERROR_CODE, type ConnectorRequest, type ConnectorsResult } from "../../orchestration/contracts.ts";
import { RpcErrorReply } from "../../orchestration/transport/server.ts";
import { createReadRoutes, type ReadRouteLink } from "./readRoutes.ts";

function setup(features = true) {
  const calls: ConnectorRequest[] = [];
  let fail = false;
  const db = new Database(":memory:");
  const routes = createReadRoutes({
    db,
    link: { isConnected: () => true } as ReadRouteLink,
    features: features ? ["connectors"] : [],
    workspaceEnabled: true,
    connectors: {
      connectors: async (q): Promise<ConnectorsResult> => {
        calls.push(q);
        if (fail) throw new RpcErrorReply("Invalid token", CONNECTOR_ERROR_CODE);
        if (q.action === "list") return { kind: "list", servers: [] };
        if (q.action === "begin") return { kind: "auth", name: "Fastmail", authUrl: "https://auth.example.com/authorize" };
        if (q.action === "remove") return { kind: "removed" };
        return { kind: "server", server: null };
      },
    },
  });
  const request = async (path: string, method = "GET", body?: unknown) =>
    routes.handle(
      new Request(`https://agent.example.com${path}`, {
        method,
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      }),
      path,
    );
  return {
    calls,
    request,
    db,
    fail: () => {
      fail = true;
    },
  };
}

test("connector routes validate requests, unwrap responses and return actionable auth errors", async () => {
  const s = setup();
  expect(await (await s.request("/api/connectors"))!.json()).toEqual([]);
  const res = await s.request("/api/connectors/begin", "POST", { url: "https://api.fastmail.com/mcp", token: "secret" });
  expect(await res!.json()).toEqual({ name: "Fastmail", authUrl: "https://auth.example.com/authorize" });
  expect(s.calls[1]).toEqual({ action: "begin", url: "https://api.fastmail.com/mcp", token: "secret" });
  expect((await s.request("/api/connectors/begin", "POST", { url: "garbage" }))!.status).toBe(400);
  expect((await s.request("/api/connectors/invalid/remove", "POST", {}))!.status).toBe(400);
  expect((await s.request("/api/connectors/begin", "PUT"))!.status).toBe(405);
  s.fail();
  const failed = await s.request("/api/connectors/begin", "POST", { url: "https://api.fastmail.com/mcp" });
  expect(failed!.status).toBe(422);
  expect(await failed!.json()).toEqual({ error: "Invalid token" });
  s.db.close();
});

test("disabled connector feature rejects both reads and mutations before reaching the workspace", async () => {
  const s = setup(false);
  expect((await s.request("/api/connectors"))!.status).toBe(404);
  expect((await s.request("/api/connectors/begin", "POST", { url: "https://api.fastmail.com/mcp" }))!.status).toBe(404);
  expect(s.calls).toEqual([]);
  s.db.close();
});
