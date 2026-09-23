import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { BrowserUpdate } from "../contracts.ts";
import { BrowserRelay } from "./browserStream.ts";

let server: Server<undefined> | null = null;
let relay: BrowserRelay | null = null;
afterEach(() => {
  relay?.stop();
  server?.stop(true);
  relay = null;
  server = null;
});

function fakeStream(onOpen: (ws: ServerWebSocket<undefined>) => void): number {
  server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: { open: onOpen, message: () => {} },
  });
  return server.port!;
}

const until = async (cond: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

describe("BrowserRelay", () => {
  test("maps stream messages and keeps only the newest frame inside the throttle window", async () => {
    const port = fakeStream((ws) => {
      ws.send(JSON.stringify({ type: "status", connected: true }));
      ws.send(JSON.stringify({ type: "tabs", tabs: [{ active: true, url: "https://a.test/", title: "A" }] }));
      for (const data of ["f1", "f2", "f3"]) {
        ws.send(JSON.stringify({ type: "frame", data, metadata: { deviceWidth: 1024, deviceHeight: 576 } }));
      }
    });
    const got: BrowserUpdate[] = [];
    relay = new BrowserRelay(port, (u) => got.push(u));
    await until(() => got.filter((u) => u.frame).length >= 2);

    expect(got[0]).toEqual({ connected: true });
    expect(got[1]).toEqual({ url: "https://a.test/", title: "A" });
    // f1 goes out immediately; f2 is superseded by f3 within the window.
    expect(got.filter((u) => u.frame).map((u) => u.frame)).toEqual(["f1", "f3"]);
    expect(got.find((u) => u.frame)).toMatchObject({ width: 1024, height: 576 });
  });

  test("reports disconnected when no browser is listening yet", async () => {
    const got: BrowserUpdate[] = [];
    relay = new BrowserRelay(1, (u) => got.push(u));
    await until(() => got.length > 0);
    expect(got[0]).toEqual({ connected: false });
  });
});
