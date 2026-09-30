import { describe, expect, test } from "bun:test";
import { CHAT_HISTORY_UNKNOWN_CURSOR, CHAT_HISTORY_UNKNOWN_CURSOR_CODE, type WorkspaceRegisterResult } from "../contracts.ts";
import { ConnectionClosedError, NotConnectedError, OrchestrationClient, RequestTimeoutError, RpcHandlerError } from "./client.ts";

// A bare WS peer standing in for the bot: acks register, then lets the test drive raw frames.
function fakeOrchestrator(registerResult: unknown = { ok: true }) {
  const received: Array<Record<string, unknown>> = [];
  let peer: { send(data: string): void } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        peer = ws;
      },
      message(ws, raw) {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg.method === "runner/register") ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: registerResult }));
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}`,
    received,
    send: (m: unknown) => peer!.send(JSON.stringify(m)),
    drop: () => (peer as unknown as { close(): void }).close(),
    stop: () => server.stop(true),
  };
}

const waitFor = async (pred: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

describe("OrchestrationClient extra handlers", () => {
  test("routes custom requests, answers unknown methods, resolves its own requests, and fires onRegistered", async () => {
    const orch = fakeOrchestrator();
    let registered = 0;
    let state: "idle" | "streaming" = "streaming";
    const client = new OrchestrationClient({
      url: orch.url,
      runnerId: "workspace-drk",
      kind: "pi-workspace",
      state: () => state,
      heartbeatMs: 0,
      handlers: {
        "chat/abort": async () => ({ aborted: true }),
        "chat/history": async () => {
          throw new RpcHandlerError(CHAT_HISTORY_UNKNOWN_CURSOR, CHAT_HISTORY_UNKNOWN_CURSOR_CODE);
        },
        "chat/new": async () => {
          throw new Error("plain");
        },
      },
      onRegistered: () => registered++,
    });
    const running = client.run();
    try {
      await waitFor(() => registered === 1);
      expect(registered).toBe(1);
      expect((orch.received[0].params as { state: string; role: string }).state).toBe("streaming");

      orch.send({ jsonrpc: "2.0", id: 10, method: "chat/abort", params: { principalId: "drk" } });
      orch.send({ jsonrpc: "2.0", id: 11, method: "chat/unknown", params: {} });
      orch.send({ jsonrpc: "2.0", id: 12, method: "chat/history", params: {} });
      orch.send({ jsonrpc: "2.0", id: 13, method: "chat/new", params: {} });
      await waitFor(() => orch.received.length >= 5);
      expect(orch.received.find((m) => m.id === 10)).toMatchObject({ result: { aborted: true } });
      expect(orch.received.find((m) => m.id === 11)).toMatchObject({ error: { code: -32601 } });
      expect(orch.received.find((m) => m.id === 12)).toMatchObject({ error: { code: CHAT_HISTORY_UNKNOWN_CURSOR_CODE, message: CHAT_HISTORY_UNKNOWN_CURSOR } });
      expect(orch.received.find((m) => m.id === 13)).toMatchObject({ error: { code: -32000, message: "plain" } });

      const reply = client.request("chat/deliver", { outboxId: "o1" });
      await waitFor(() => orch.received.some((m) => m.method === "chat/deliver"));
      const sent = orch.received.find((m) => m.method === "chat/deliver")!;
      orch.send({ jsonrpc: "2.0", id: sent.id, result: {} });
      expect(await reply).toEqual({});
    } finally {
      client.close();
      await running;
      orch.stop();
    }
  });
});

const WEB_SEARCH = { name: "web_search", description: "search", inputSchema: { type: "object", properties: {}, additionalProperties: false }, approval: "none" };

async function registeredWith(registerResult: unknown) {
  const orch = fakeOrchestrator(registerResult);
  const results: WorkspaceRegisterResult[] = [];
  const client = new OrchestrationClient({ url: orch.url, runnerId: "r", kind: "k", heartbeatMs: 0, onRegistered: (r) => results.push(r) });
  const running = client.run();
  await waitFor(() => results.length === 1);
  client.close();
  await running;
  orch.stop();
  return results;
}

describe("OrchestrationClient register result", () => {
  test("a workspace gets the parsed tool manifest", async () => {
    expect(await registeredWith({ ok: true, tools: [WEB_SEARCH] })).toEqual([{ ok: true, tools: [WEB_SEARCH] as WorkspaceRegisterResult["tools"] }]);
  });

  test("a malformed manifest entry drops only that entry", async () => {
    const newerApproval = { ...WEB_SEARCH, name: "file_linear_issue", approval: "twice" };
    expect(await registeredWith({ ok: true, tools: [{ name: 1 }, newerApproval, WEB_SEARCH] })).toEqual([
      { ok: true, tools: [WEB_SEARCH] as WorkspaceRegisterResult["tools"] },
    ]);
  });

  test("a result with no tools list reads as no tools", async () => {
    expect(await registeredWith({ ok: true, tools: "web_search" })).toEqual([{ ok: true, tools: [] }]);
  });

  test("registers as a workspace explicitly", async () => {
    const orch = fakeOrchestrator();
    const client = new OrchestrationClient({ url: orch.url, runnerId: "r", kind: "k", heartbeatMs: 0 });
    await client.connect();
    client.close();
    orch.stop();
    expect((orch.received.find((m) => m.method === "runner/register")?.params as { role?: string }).role).toBe("workspace");
  });
});

describe("OrchestrationClient.request failures", () => {
  async function connected() {
    const orch = fakeOrchestrator();
    const client = new OrchestrationClient({ url: orch.url, runnerId: "r", kind: "k", heartbeatMs: 0 });
    await client.connect();
    client.listen();
    return { orch, client };
  }

  test("a timeout rejects once and a late response is ignored", async () => {
    const { orch, client } = await connected();
    try {
      const reply = client.request("tool/call", {}, { timeoutMs: 30 });
      await expect(reply).rejects.toBeInstanceOf(RequestTimeoutError);
      const sent = orch.received.find((m) => m.method === "tool/call")!;
      orch.send({ jsonrpc: "2.0", id: sent.id, result: { ok: true, result: "late" } });
      await new Promise((r) => setTimeout(r, 20));
      expect(orch.received.filter((m) => m.method === "tool/call")).toHaveLength(1);
    } finally {
      client.close();
      orch.stop();
    }
  });

  test("a dropped link rejects in-flight requests with ConnectionClosedError; a closed one with NotConnectedError", async () => {
    const { orch, client } = await connected();
    try {
      const reply = client.request("tool/call", {}, { timeoutMs: 5_000 });
      await waitFor(() => orch.received.some((m) => m.method === "tool/call"));
      orch.drop();
      await expect(reply).rejects.toBeInstanceOf(ConnectionClosedError);
      await expect(client.request("tool/call", {})).rejects.toBeInstanceOf(NotConnectedError);
    } finally {
      client.close();
      orch.stop();
    }
  });
});
