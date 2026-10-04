import { expect, test } from "bun:test";
import { BrowserRelay, createBrowserRoutes } from "./browserRoutes.ts";
import type { ServerWebSocket } from "bun";
import type { VoiceSocketData } from "./voice/session.ts";
import { createWebHandler } from "./server.ts";
import type { WebConfig } from "../../config.ts";

const status = { id: "browser-one", conversationId: "main", state: "active" as const, runId: "run", action: "Reading page" };
test("browser upgrades require exact browser origin; cross-site and anonymous requests cannot view", async () => {
  const routes = createBrowserRoutes({ isConnected: () => true, browserRead: async () => ({ status }) });
  const request = (headers: Record<string, string> = {}) => new Request("https://agent.example/api/browser/connect", { headers: { Upgrade: "websocket", ...headers } });
  expect((await routes.handle(request(), "/api/browser/connect"))?.status).toBe(403);
  expect((await routes.handle(request({ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }), "/api/browser/connect"))?.status).toBe(403);
  let upgraded = false;
  expect((await routes.handle(request({ Origin: "https://agent.example" }), "/api/browser/connect", { timeout() {}, upgrade() { upgraded = true; return true; } }))?.status).toBe(204);
  expect(upgraded).toBe(true);
  routes.close();
  const config = { ownerLogin: "owner", bindAddr: "127.0.0.1", distDir: "/tmp", trustedPeers: [] } as unknown as WebConfig;
  const gateway = createWebHandler({ config, peers: () => false, browser: routes });
  expect((await gateway(request({ Origin: "https://agent.example" }), "10.0.0.2"))?.status).toBe(403);
});

test("viewer receives bounded frames, must acknowledge, and cannot inject mouse or keyboard events", async () => {
  let reads = 0;
  let closed = 0;
  const sent: unknown[] = [];
  const frame = { seq: 1, data: "/9j/", width: 1280, height: 800, capturedAt: Date.now() };
  const relay = new BrowserRelay(async () => { reads++; return { status, frame }; }, 15, () => { closed++; });
  const socket = { send(raw: string) { sent.push(JSON.parse(raw)); return 1; }, close() {}, getBufferedAmount: () => 0 } as unknown as ServerWebSocket<VoiceSocketData>;
  relay.open(socket);
  await Bun.sleep(170);
  expect(sent).toContainEqual({ type: "frame", id: status.id, ...frame });
  expect(reads).toBe(1);
  relay.message(socket, JSON.stringify({ type: "ack", seq: 1 }));
  await Bun.sleep(90);
  expect(reads).toBeGreaterThan(1);
  relay.message(socket, JSON.stringify({ type: "input_mouse", x: 10, y: 10 }));
  expect(closed).toBe(1);
});

test("a completed session sends Finished and ends the viewer without stopping other tasks", async () => {
  const sent: unknown[] = [];
  let closed = false;
  const relay = new BrowserRelay(async () => ({ status: { ...status, state: "ended", endedAt: Date.now() } }), 5, () => { closed = true; });
  relay.open({ send: (raw: string) => { sent.push(JSON.parse(raw)); return 1; }, close() {}, getBufferedAmount: () => 0 } as unknown as ServerWebSocket<VoiceSocketData>);
  await Bun.sleep(10);
  expect(sent).toMatchObject([{ type: "status", status: { state: "ended" } }]);
  expect(closed).toBe(true);
});
