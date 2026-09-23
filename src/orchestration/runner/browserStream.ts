import { createServer } from "node:net";
import type { BrowserUpdate } from "../contracts.ts";

const MIN_FRAME_GAP_MS = 100; // ≤10fps; the screencast only emits on change, so idle pages cost nothing
const RETRY_MS = 2000;

/** A free localhost port for a task's agent-browser stream server. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

/**
 * Relays one task's agent-browser stream (ws://127.0.0.1:<port>) as BrowserUpdates. Connects by
 * port instead of `agent-browser stream status`, which would launch a browser as a side effect;
 * until the agent opens one the connect just fails and is retried. Frames are throttled with the
 * newest kept, so a busy page never builds a backlog.
 */
export class BrowserRelay {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFrame: BrowserUpdate | null = null;
  private lastFrameAt = 0;
  private connected: boolean | null = null;

  constructor(
    private readonly port: number,
    private readonly emit: (u: BrowserUpdate) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`);
    this.ws = ws;
    ws.onmessage = (m) => this.onMessage(String(m.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.emit({ connected });
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "status":
        this.setConnected(msg.connected === true);
        return;
      case "tabs": {
        const tabs = (msg.tabs as { active?: boolean; url?: string; title?: string }[] | undefined) ?? [];
        const active = tabs.find((t) => t.active);
        if (active) this.emit({ url: active.url, title: active.title });
        return;
      }
      case "url":
        if (typeof msg.url === "string") this.emit({ url: msg.url });
        return;
      case "frame": {
        const meta = (msg.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
        this.pendingFrame = { frame: String(msg.data ?? ""), width: meta.deviceWidth, height: meta.deviceHeight };
        this.flushFrame();
        return;
      }
    }
  }

  private flushFrame(): void {
    if (!this.pendingFrame || this.frameTimer) return;
    const wait = this.lastFrameAt + MIN_FRAME_GAP_MS - this.now();
    if (wait > 0) {
      this.frameTimer = setTimeout(() => {
        this.frameTimer = null;
        this.flushFrame();
      }, wait);
      return;
    }
    this.lastFrameAt = this.now();
    this.emit(this.pendingFrame);
    this.pendingFrame = null;
  }
}
