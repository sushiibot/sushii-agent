import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { encodeEvent, parseCursor, sseResponse } from "./sse.ts";

function log() {
  const db = new Database(":memory:");
  applySchema(db);
  return new SqliteChatLog(db);
}

async function drain(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

describe("sse", () => {
  test("encodes durable events with an id and ephemeral ones without", () => {
    expect(new TextDecoder().decode(encodeEvent({ seq: 7, type: "session", data: { kind: "new" } }))).toBe('id: 7\nevent: session\ndata: {"kind":"new"}\n\n');
    expect(new TextDecoder().decode(encodeEvent({ type: "workspace", data: { state: "online" } }))).toBe('event: workspace\ndata: {"state":"online"}\n\n');
  });

  test("parses the cursor from the query first, then Last-Event-ID", () => {
    expect(parseCursor(new Request("http://x/s?after=5", { headers: { "Last-Event-ID": "9" } }))).toBe(5);
    expect(parseCursor(new Request("http://x/s", { headers: { "Last-Event-ID": "9" } }))).toBe(9);
    expect(parseCursor(new Request("http://x/s"))).toBeNull();
    expect(parseCursor(new Request("http://x/s?after=-1"))).toBeUndefined();
  });

  test("closes at the lifetime and runs the close hook once", async () => {
    const chat = log();
    let opened = 0;
    let closed = 0;
    const res = sseResponse(chat, null, {
      heartbeatMs: 1_000,
      maxLifetimeMs: 20,
      onOpen: () => (opened++, () => closed++),
      hello: () => ({ workspace: "offline", openTurns: [] }),
    });
    const text = await drain(res);
    expect(text).toStartWith("event: hello\n");
    expect([opened, closed, chat.subscribers]).toEqual([1, 1, 0]);
  });

  test("an aborted request closes the stream", async () => {
    const chat = log();
    const ctrl = new AbortController();
    const res = sseResponse(chat, null, { heartbeatMs: 1_000, maxLifetimeMs: 60_000, onOpen: () => () => {}, hello: () => ({ workspace: "online", openTurns: [] }), signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await drain(res);
    expect(chat.subscribers).toBe(0);
  });

  test("a client that stops reading is cut off instead of buffering without bound", async () => {
    const chat = log();
    const res = sseResponse(chat, null, { heartbeatMs: 1_000, maxLifetimeMs: 60_000, onOpen: () => () => {}, hello: () => ({ workspace: "online", openTurns: [] }), maxBufferedBytes: 1024 });
    for (let i = 0; i < 1000; i++) chat.publish({ type: "delta", data: { turnId: "t", offset: i * 100, text: "x".repeat(100) } });
    expect(chat.subscribers).toBe(0);
    await res.body!.cancel();
  });
});
