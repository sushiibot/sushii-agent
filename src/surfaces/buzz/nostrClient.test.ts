import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NostrRelayConnection, type NostrEvent } from "./nostrClient.ts";

// A fixed key so finalizeEvent produces a real signed AUTH event we can inspect.
const SEC = "ce4537386cd678abd684afcd43bcc6ae77220877a312a688ec77b07e6585a76b";
const sk = Uint8Array.from(Buffer.from(SEC, "hex"));

/** Minimal WebSocket stand-in: records sent frames, lets the test drive open/message/close. */
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: unknown[][] = [];
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit("close", {}); }
  private emit(type: string, e: unknown) { for (const cb of this.listeners[type] ?? []) cb(e); }
  fireOpen() { this.readyState = MockWebSocket.OPEN; this.emit("open", {}); }
  recv(msg: unknown[]) { this.emit("message", { data: JSON.stringify(msg) }); }
  frames(type: string) { return this.sent.filter((f) => f[0] === type); }
}

const realWs = globalThis.WebSocket;
beforeEach(() => { MockWebSocket.instances = []; (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket; });
afterEach(() => { (globalThis as { WebSocket: unknown }).WebSocket = realWs; });

describe("NostrRelayConnection auth + subscribe handshake", () => {
  test("does not REQ before auth, then subscribes (via onReady) after AUTH OK", () => {
    let conn: NostrRelayConnection;
    conn = new NostrRelayConnection("wss://relay.test", sk, null, "test", () => {
      conn.subscribe("m:ch1", { "#h": ["ch1"], "#p": ["PUBKEY"], since: 1234 }, () => {});
    });
    conn.start();
    const ws = MockWebSocket.instances[0];
    ws.fireOpen();

    // No REQ before auth — the bug was sending an unauthenticated REQ here.
    expect(ws.frames("REQ")).toHaveLength(0);

    ws.recv(["AUTH", "challenge-xyz"]);
    const authEvent = ws.frames("AUTH")[0][1] as { id: string };
    expect(ws.frames("REQ")).toHaveLength(0); // still nothing until AUTH is OK'd

    ws.recv(["OK", authEvent.id, true]);
    const reqFrame = ws.frames("REQ")[0];
    expect(reqFrame).toBeDefined();
    expect(reqFrame[1]).toBe("m:ch1");
    expect(reqFrame[2]).toEqual({ "#h": ["ch1"], "#p": ["PUBKEY"], since: 1234 });
  });

  test("routes live EVENTs on a sub to its handler", () => {
    const got: NostrEvent[] = [];
    let conn: NostrRelayConnection;
    conn = new NostrRelayConnection("wss://relay.test", sk, null, "test", () => {
      conn.subscribe("m:ch1", { "#h": ["ch1"] }, (e) => got.push(e));
    });
    conn.start();
    const ws = MockWebSocket.instances[0];
    ws.fireOpen();
    ws.recv(["AUTH", "c"]);
    ws.recv(["OK", (ws.frames("AUTH")[0][1] as { id: string }).id, true]);

    const evt = { id: "e1", pubkey: "someone", kind: 9, content: "hi", created_at: 5, tags: [], sig: "s" };
    ws.recv(["EVENT", "m:ch1", evt]);
    expect(got).toEqual([evt]);
  });

  test("publish and query reject before the connection is ready", async () => {
    const conn = new NostrRelayConnection("wss://relay.test", sk, null, "test");
    conn.start();
    MockWebSocket.instances[0].fireOpen(); // open but not yet authenticated
    await expect(conn.publish({ kind: 9, content: "x", tags: [] })).rejects.toThrow();
    await expect(conn.query({ kinds: [39000] })).rejects.toThrow();
  });

  test("appends the NIP-OA auth tag to the AUTH event when configured", () => {
    const authTag = ["n", "ownerpk", "", "sig"];
    const conn = new NostrRelayConnection("wss://relay.test", sk, authTag, "test");
    conn.start();
    const ws = MockWebSocket.instances[0];
    ws.fireOpen();
    ws.recv(["AUTH", "challenge"]);
    const authEvent = ws.frames("AUTH")[0][1] as { tags: string[][] };
    expect(authEvent.tags).toContainEqual(authTag);
  });
});
