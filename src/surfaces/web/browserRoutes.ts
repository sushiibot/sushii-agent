import type { ServerWebSocket } from "bun";
import { TOPIC_ID_RE } from "../../orchestration/contracts.ts";
import type { BrowserReadResult } from "../../orchestration/browserContracts.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { RequestTimeouts } from "./server.ts";
import type { VoiceSocketData } from "./voice/session.ts";
import { json } from "./http.ts";
import { unavailableFor } from "./readRoutes.ts";

type BrowserLink = Pick<WorkspaceLink, "isConnected" | "browserRead">;

/** Read-only relay: clients may acknowledge frames, never inject browser input. */
export class BrowserRelay {
  private socket?: ServerWebSocket<VoiceSocketData>;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private waiting?: { seq: number; at: number };
  private lastFrame = "";
  private lastStatus = "";
  private statusAt = 0;
  constructor(private readonly read: () => Promise<BrowserReadResult>, private readonly fps: number, private readonly onclose: () => void) {}
  open(socket: ServerWebSocket<VoiceSocketData>) { this.socket = socket; void this.tick(); }
  message(_socket: ServerWebSocket<VoiceSocketData>, raw: string | Buffer) {
    if (typeof raw !== "string" || raw.length > 100) return this.close(1008);
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "ping") return;
      if (msg.type !== "ack" || !Number.isSafeInteger(msg.seq) || msg.seq !== this.waiting?.seq) return this.close(1008);
      this.waiting = undefined;
    } catch { this.close(1008); }
  }
  private async tick() {
    if (this.closed) return;
    if (this.waiting) {
      if (Date.now() - this.waiting.at > 10_000) return this.close(1008);
    } else {
      try {
        const result = await this.read();
        if (this.closed) return;
        const status = JSON.stringify(result.status);
        if (status !== this.lastStatus || Date.now() - this.statusAt > 1000) {
          this.socket?.send(JSON.stringify({ type: "status", status: result.status }));
          this.lastStatus = status; this.statusAt = Date.now();
        }
        if (!result.status || result.status.state === "ended") return this.close(1000);
        if (result.frame) {
          const key = `${result.status.id}:${result.frame.seq}`;
          if (key !== this.lastFrame) {
            if ((this.socket?.getBufferedAmount() ?? 0) > 512 * 1024) return this.close(1013);
            this.waiting = { seq: result.frame.seq, at: Date.now() };
            this.socket?.send(JSON.stringify({ type: "frame", id: result.status.id, ...result.frame }));
            this.lastFrame = key;
          }
        }
      } catch { return this.close(1013); }
    }
    if (!this.closed) this.timer = setTimeout(() => void this.tick(), 1000 / this.fps);
  }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.close(code);
    this.onclose();
  }
}

export function createBrowserRoutes(link: BrowserLink) {
  const relays = new Set<BrowserRelay>();
  return {
    async handle(req: Request, path: string, server?: RequestTimeouts): Promise<Response | null> {
      if (path !== "/api/browser/status" && path !== "/api/browser/connect") return null;
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const url = new URL(req.url);
      const conversation = url.searchParams.get("conversation") ?? "main";
      if (!TOPIC_ID_RE.test(conversation)) return json({ error: "Invalid conversation" }, 400);
      if (path.endsWith("/status")) {
        try { return json(await link.browserRead(conversation)); }
        catch (err) { const unavailable = unavailableFor(err); return unavailable ? json(unavailable.body, unavailable.status) : json({ error: "Browser unavailable" }, 503); }
      }
      let origin: URL;
      try { origin = new URL(req.headers.get("Origin") ?? ""); }
      catch { return json({ error: "forbidden" }, 403); }
      if (origin.host !== url.host || !["https:", "http:"].includes(origin.protocol) ||
        (req.headers.has("Sec-Fetch-Site") && req.headers.get("Sec-Fetch-Site") !== "same-origin")) return json({ error: "forbidden" }, 403);
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket required" }, 400);
      if (!link.isConnected()) return json({ offline: true }, 503);
      if (relays.size >= 4) return json({ error: "Too many browser viewers" }, 429);
      const fps = url.searchParams.get("fps") === "15" ? 15 : 5;
      const relay = new BrowserRelay(() => link.browserRead(conversation, true), fps, () => relays.delete(relay));
      relays.add(relay);
      if (!server?.upgrade?.(req, { browser: relay })) { relay.close(); return json({ error: "Couldn't start browser preview" }, 503); }
      return new Response(null, { status: 204 });
    },
    close() { for (const relay of relays) relay.close(); },
  };
}
export type BrowserRoutes = ReturnType<typeof createBrowserRoutes>;
