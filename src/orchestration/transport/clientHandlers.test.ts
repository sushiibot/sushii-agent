import { describe, expect, test } from "bun:test";
import { OrchestrationClient } from "./client.ts";

// A bare WS peer standing in for the bot: acks register, then lets the test drive raw frames.
function fakeOrchestrator() {
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
        if (msg.method === "runner/register") ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
      },
    },
  });
  return { url: `ws://localhost:${server.port}`, received, send: (m: unknown) => peer!.send(JSON.stringify(m)), stop: () => server.stop(true) };
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
      role: "workspace",
      state: () => state,
      heartbeatMs: 0,
      handlers: { "chat/abort": async () => ({ aborted: true }) },
      onRegistered: () => registered++,
    });
    const running = client.run();
    try {
      await waitFor(() => registered === 1);
      expect(registered).toBe(1);
      expect((orch.received[0].params as { state: string; role: string }).state).toBe("streaming");

      orch.send({ jsonrpc: "2.0", id: 10, method: "chat/abort", params: { principalId: "drk" } });
      orch.send({ jsonrpc: "2.0", id: 11, method: "chat/unknown", params: {} });
      await waitFor(() => orch.received.length >= 3);
      expect(orch.received.find((m) => m.id === 10)).toMatchObject({ result: { aborted: true } });
      expect(orch.received.find((m) => m.id === 11)).toMatchObject({ error: { code: -32601 } });

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
