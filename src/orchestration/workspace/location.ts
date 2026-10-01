import { randomBytes } from "node:crypto";
import { z } from "zod";
import { WEB_CONVERSATION_ID, type ToolCallParams, type ToolCallResult, type ToolManifestEntry } from "../contracts.ts";
import type { ConnectionInfo } from "../transport/server.ts";
import type { ApprovalDecision, ApprovalView, SurfaceActor, SurfaceMessageHandle } from "./surface.ts";

export const LOCATION_TOOL = "request_current_location";
export const LOCATION_TIMEOUT_MS = 90_000;
export const locationReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("shared"), latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracy: z.number().finite().min(0).max(10_000_000), timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ status: z.enum(["denied", "unsupported", "timeout", "unavailable", "cancelled"]) }).strict(),
]);
export const locationManifest: ToolManifestEntry = {
  name: LOCATION_TOOL,
  description: "Ask the owner to share a one-time current location from their own browser for nearby questions. Requires an explicit Share current location click and browser permission; never use agent-browser geolocation. Only available to the main personal conversation. Waits at most 90 seconds. If rejected or unavailable, ask for a city/area instead; do not retry without the user asking. Coordinates are sensitive transient task context: never copy them into durable memory, notes, logs or analytics, and do not repeat exact coordinates in chat unless asked. Tool history is stored.",
  inputSchema: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: 300 } }, required: ["reason"], additionalProperties: false },
  approval: "none", // This is a data request, not an executable action approval.
};
const requestArgs = z.object({ reason: z.string().trim().min(1).max(300) }).strict();
interface Pending {
  conn: ConnectionInfo;
  callId: string;
  view: ApprovalView;
  handle?: SurfaceMessageHandle;
  decision?: ApprovalDecision;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: ToolCallResult) => void;
}

/** Owner-only web has one conversation (main). Nonces bind replies to a live call on one connection;
 * coordinates go only to that call, never the durable approval log. Restarts invalidate all nonces. */
export class BrowserLocationRequests {
  private pending = new Map<string, Pending>();
  constructor(private readonly opts: {
    isOwner: (actor: SurfaceActor) => boolean;
    prompt: (view: ApprovalView, nonce: string) => Promise<SurfaceMessageHandle>;
    resolved: (handle: SurfaceMessageHandle, view: ApprovalView, nonce: string, decision: ApprovalDecision) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  }) {}

  async request(conn: ConnectionInfo, p: ToolCallParams): Promise<ToolCallResult> {
    const args = requestArgs.safeParse(p.args);
    if (!args.success) return { ok: false, error: "invalid location request arguments" };
    if (p.agentId !== "main" || p.parentRunId) return { ok: false, error: "location is only available in the main personal conversation" };
    if (this.pending.size >= 1) return { ok: false, error: "a location request is already pending" };
    const nonce = randomBytes(12).toString("base64url");
    const view: ApprovalView = { tool: LOCATION_TOOL, agentId: p.agentId, agentName: p.agentName, fields: [{ key: "reason", value: args.data.reason, kind: "body" }, { key: "conversation", value: WEB_CONVERSATION_ID, kind: "body" }] };
    let resolve!: (r: ToolCallResult) => void;
    const result = new Promise<ToolCallResult>((r) => { resolve = r; });
    const pending: Pending = { conn, callId: p.callId, view, resolve, timer: setTimeout(() => this.settle(nonce, { ok: false, error: "location request timed out: no responding browser within 90 seconds; ask for a city/area instead" }, "timeout"), this.opts.timeoutMs ?? LOCATION_TIMEOUT_MS) };
    this.pending.set(nonce, pending);
    // Do not await posting before waiting for the bounded result: even a hung adapter cannot block it.
    void (async () => this.opts.prompt(view, nonce))().then((handle) => {
      pending.handle = handle;
      if (!this.pending.has(nonce)) void this.opts.resolved(handle, view, nonce, pending.decision ?? "cancelled").catch(() => {});
    }, () => this.settle(nonce, { ok: false, error: "the user's web browser surface is unavailable; ask for a city/area instead" }, "cancelled"));
    return result;
  }

  fulfill(nonce: string, raw: unknown, actor: SurfaceActor): "decided" | "forbidden" | "expired" | "invalid" {
    if (actor.surface !== "web" || !this.opts.isOwner(actor)) return "forbidden";
    if (!this.pending.has(nonce)) return "expired";
    const reply = locationReply.safeParse(raw);
    if (!reply.success) return "invalid";
    const r = reply.data;
    if (r.status === "shared") {
      const now = (this.opts.now ?? Date.now)();
      if (r.timestamp < now - 120_000 || r.timestamp > now + 30_000) return "invalid";
      this.settle(nonce, { ok: true, result: JSON.stringify({ ...r, privacy: "Use only for this nearby question; do not save exact coordinates in durable memory." }) }, "approve");
    } else {
      this.settle(nonce, { ok: false, error: `browser location ${r.status}; ask for a city/area instead`, ...(r.status === "denied" ? { denied: true } : {}) }, r.status === "denied" ? "deny" : "cancelled");
    }
    return "decided";
  }

  deny(nonce: string, actor: SurfaceActor) { return this.fulfill(nonce, { status: "denied" }, actor); }
  has(nonce: string) { return this.pending.has(nonce); }
  cancel(conn: ConnectionInfo, callId?: string): boolean {
    let cancelled = false;
    for (const [nonce, p] of this.pending) if (p.conn === conn && (callId === undefined || p.callId === callId)) {
      cancelled = this.settle(nonce, { ok: false, error: "location request cancelled" }, "cancelled") || cancelled;
    }
    return cancelled;
  }
  private settle(nonce: string, result: ToolCallResult, decision: ApprovalDecision): boolean {
    const p = this.pending.get(nonce);
    if (!p) return false;
    this.pending.delete(nonce);
    clearTimeout(p.timer);
    p.decision = decision;
    p.resolve(result);
    if (p.handle) void this.opts.resolved(p.handle, p.view, nonce, decision).catch(() => {});
    return true;
  }
}
