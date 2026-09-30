import { z } from "zod";
import { ID_MAX, WEB_CONVERSATION_ID, uploadUrl, type ChatMessageParams, type ChatOrigin } from "../../orchestration/contracts.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import { handleOwnerMessage, type OwnerRouterDeps } from "../../orchestration/workspace/router.ts";
import type { InboundMessage, RouterNotice, SurfaceActor } from "../../orchestration/workspace/surface.ts";
import { APPROVAL_TIMEOUT_MS, NONCE_RE, type WorkspaceTools } from "../../orchestration/workspace/tools.ts";
import { getLogger } from "../../logger.ts";
import { WEB_SURFACE } from "./actor.ts";
import { INBOUND_RETENTION_MS, type SqliteChatLog } from "./chatLog.ts";
import {
  CLIENT_ID_RE,
  HISTORY_LIMIT_MAX,
  MESSAGE_TEXT_MAX,
  MESSAGE_UPLOADS_MAX,
  UPLOAD_ID_RE,
  type DiscardMessageResponse,
  type DiscardMessageRoutedResponse,
  type PostApprovalResponse,
  type PostAskResponse,
  type PostMessageResponse,
  type PostMessageUploadMissingResponse,
  type UploadRef,
} from "./events.ts";
import { historyPage } from "./history.ts";
import { forbidden, isJson, json, readJson } from "./http.ts";
import type { InboundRow, WebInboundStore } from "./inbound.ts";
import type { Presence } from "./presence.ts";
import { parseCursor, sseResponse, SSE_HEARTBEAT_MS, SSE_MAX_LIFETIME_MS } from "./sse.ts";
import type { WebUploadPort, WebWorkspaceAdapter } from "./workspaceAdapter.ts";

const log = getLogger("web/chatRoutes");

/** MESSAGE_TEXT_MAX chars can reach ~48 KB of UTF-8, plus the JSON around it. */
export const MESSAGE_BODY_MAX = 64 * 1024;
export const HISTORY_RESPONSE_MAX = 2 * 1024 * 1024;
const HISTORY_DEFAULT_LIMIT = 40;
const PENDING_ASKS_MAX = 10;
const SHUTDOWN_IDLE_MS = 2_000;
/** How long a delete waits for a route already in flight to settle before calling the message delivered. */
const DISCARD_WAIT_MS = 20_000;

export const WEB_ORIGIN: ChatOrigin = Object.freeze({ surface: WEB_SURFACE, conversationId: WEB_CONVERSATION_ID });

export type ChatRouteLink = Pick<
  WorkspaceLink,
  | "isConnected"
  | "sendMessage"
  | "abort"
  | "newSession"
  | "recordOffline"
  | "interceptReply"
  | "isOwner"
  | "isLoginPending"
  | "startLogin"
  | "completeLogin"
  | "cancelLogin"
  | "command"
  | "stopTurn"
  | "answerAsk"
>;

export interface ChatRouteDeps {
  log: SqliteChatLog;
  inbound: WebInboundStore;
  adapter: WebWorkspaceAdapter;
  presence: Presence;
  link: ChatRouteLink;
  tools: Pick<WorkspaceTools, "decide">;
  workspaceEnabled: boolean;
  uploads?: WebUploadPort;
  now?: () => number;
  sse?: { heartbeatMs: number; maxLifetimeMs: number };
  historyMaxBytes?: number;
  discardWaitMs?: number;
}

export interface ChatRoutes {
  handle(req: Request, path: string, actor: SurfaceActor, server?: { timeout(req: Request, seconds: number): void }): Promise<Response | null>;
  closeStreams(): void;
  /** Resolves once every message being routed has finished; for tests and shutdown. */
  idle(): Promise<void>;
  /** idle(), bounded for shutdown. */
  drain(timeoutMs?: number): Promise<void>;
  /** The workspace link (re)connected: re-route messages that were stored but never routed. */
  workspaceConnected(): void;
}

const messageBody = z
  .object({
    clientId: z.string().regex(CLIENT_ID_RE),
    text: z.string().max(MESSAGE_TEXT_MAX),
    uploadIds: z.array(z.string().regex(UPLOAD_ID_RE)).max(MESSAGE_UPLOADS_MAX).optional(),
  })
  .strict()
  .refine((b) => b.text.trim() !== "" || (b.uploadIds?.length ?? 0) > 0, "empty message");
const stopBody = z.object({ turnId: z.string().min(1).max(ID_MAX).optional() }).strict();
const commandBody = z.object({ command: z.enum(["new", "compact"]) }).strict();
const askBody = z.union([
  z.object({ index: z.number().int().min(0).max(99), label: z.string().max(ID_MAX) }).strict(),
  z.object({ text: z.string().min(1).max(MESSAGE_TEXT_MAX) }).strict(),
]);
const approvalBody = z.object({ decision: z.enum(["approve", "deny"]) }).strict();
const seenBody = z.object({ seq: z.number().int().min(0) }).strict();

export function createChatRoutes(deps: ChatRouteDeps): ChatRoutes {
  const { log: chatLog, inbound, adapter, presence, link, tools } = deps;
  const now = deps.now ?? Date.now;
  const sseTimes = deps.sse ?? { heartbeatMs: SSE_HEARTBEAT_MS, maxLifetimeMs: SSE_MAX_LIFETIME_MS };
  const historyMax = deps.historyMaxBytes ?? HISTORY_RESPONSE_MAX;
  const shutdown = new AbortController();
  // clientIds being routed right now, so a duplicate POST can't route the same message twice at once.
  const routing = new Map<string, Promise<void>>();

  const online = () => deps.workspaceEnabled && link.isConnected();
  // Routing needs a verified actor, which only a request carries; a re-drive waits for one.
  let lastActor: SurfaceActor | undefined;
  let redriveWanted = false;
  let redriving = false;
  const notice = (n: RouterNotice) => void chatLog.append("notice", n);

  /** Routes a persisted message through the owner router. A receipt (or a consuming notice) marks it
   *  routed; a workspaceOffline notice leaves it for the client to resend. */
  function drive(row: { clientId: string; text: string; uploadIds: string[] }, actor: SurfaceActor): void {
    // Checked in the same tick routing starts, so a delete either sees this route in flight or wins outright.
    if (routing.has(row.clientId) || inbound.get(row.clientId)?.state !== "pending") return;
    const run = (async () => {
      const known = row.uploadIds.length && deps.uploads ? deps.uploads.lookup(row.uploadIds) : new Map<string, UploadRef>();
      const attachments: InboundMessage["attachments"] = row.uploadIds.flatMap((id) => {
        const ref = known.get(id);
        return ref ? [{ url: uploadUrl(id), name: ref.name, contentType: ref.contentType }] : [];
      });
      const message: InboundMessage = {
        origin: WEB_ORIGIN,
        id: row.clientId,
        text: row.text,
        author: { id: actor.userId, name: actor.name },
        isVoice: false,
        attachments,
        actor,
      };
      const routerLink: OwnerRouterDeps<InboundMessage>["link"] = {
        isConnected: () => link.isConnected(),
        sendMessage: async (input: Omit<ChatMessageParams, "principalId">) => {
          const res = await link.sendMessage(input);
          // The workspace already has it (say, a resend after a bot restart): that is still a receipt.
          if (res.mode === "duplicate" && input.messageId === row.clientId) await adapter.ack(message, "accepted");
          return res;
        },
        abort: (turnId?: string) => link.abort(turnId),
        newSession: () => link.newSession(),
        recordOffline: (u, r, o) => link.recordOffline(u, r, o),
        interceptReply: (m) => link.interceptReply(m),
        isOwner: (a) => link.isOwner(a),
        isLoginPending: () => link.isLoginPending(),
        startLogin: (o) => link.startLogin(o),
        completeLogin: (i) => link.completeLogin(i),
        cancelLogin: () => link.cancelLogin(),
        command: (c, a) => link.command(c, a),
      };
      await handleOwnerMessage(message, {
        workspaceEnabled: deps.workspaceEnabled,
        transcriptionEnabled: false,
        link: routerLink,
        surface: adapter,
        cursor: { advance: () => {} },
        offline: "reject",
      });
    })()
      .catch((err) => log.error({ err, clientId: row.clientId }, "routing a web message failed"))
      .finally(() => routing.delete(row.clientId));
    routing.set(row.clientId, run);
  }

  /** Routes every stored, never-routed message in the order it was sent. The workspace dedupes by clientId,
   *  so one it already took answers as a duplicate and is marked routed. */
  function redriveUnrouted(): void {
    redriveWanted = true;
    const actor = lastActor;
    if (redriving || !actor || !online() || shutdown.signal.aborted) return;
    redriving = true;
    redriveWanted = false;
    void (async () => {
      for (const row of inbound.unrouted(now() - INBOUND_RETENTION_MS)) {
        if (!online() || shutdown.signal.aborted) break;
        drive(row, actor);
        await routing.get(row.clientId);
      }
    })()
      .catch((err) => log.error({ err }, "re-routing stored web messages failed"))
      .finally(() => {
        redriving = false;
        // A reconnect while this pass ran may have left new pending rows behind it.
        if (redriveWanted) redriveUnrouted();
      });
  }

  async function postMessage(req: Request, actor: SurfaceActor): Promise<Response> {
    const body = await parseBody(req, messageBody, MESSAGE_BODY_MAX);
    if (body instanceof Response) return body;
    const uploadIds = [...new Set(body.uploadIds ?? [])];
    const existing = inbound.get(body.clientId);
    if (existing) {
      if (existing.text !== body.text) log.warn({ clientId: body.clientId }, "a resent web message differs from the stored one; keeping the stored one");
      if (existing.state === "discarded") return json({ discarded: true } satisfies DiscardMessageResponse, 410);
      // A resend of a refused message is the owner's retry: it goes back to pending and is routed again.
      if (existing.state === "rejected") inbound.markPending(existing.clientId);
      if (existing.state !== "routed") drive(existing, actor);
      return json({ seq: existing.seq, routed: existing.state === "routed" } satisfies PostMessageResponse, 202);
    }
    if (uploadIds.length && !deps.uploads) return json({ error: "uploads are not available" }, 400);
    const at = now();
    let row: InboundRow;
    try {
      row = chatLog.transaction(() => {
        // A concurrent duplicate may have been stored while this request's body was read.
        const raced = inbound.get(body.clientId);
        if (raced) return raced;
        // In the same transaction as the insert, so a message held for days never loses its photos to orphan GC.
        const missing = uploadIds.length ? deps.uploads!.markReferenced(uploadIds, body.clientId).missing : [];
        if (missing.length) throw new UploadMissing(missing);
        const seq = chatLog.append("user", { key: body.clientId, text: body.text, uploadIds, at: new Date(at).toISOString() }, body.clientId);
        const stored = { clientId: body.clientId, text: body.text, uploadIds, seq, createdAt: at };
        inbound.insert(stored);
        return { ...stored, routedAt: null, state: "pending" as const };
      });
    } catch (err) {
      if (err instanceof UploadMissing) return json({ error: "upload_missing", ids: err.ids } satisfies PostMessageUploadMissingResponse, 409);
      throw err;
    }
    if (row.state === "discarded") return json({ discarded: true } satisfies DiscardMessageResponse, 410);
    if (row.state !== "routed") drive(row, actor);
    return json({ seq: row.seq, routed: row.state === "routed" } satisfies PostMessageResponse, 202);
  }

  /** The owner deleted a posted message: it must never reach the agent, unless it already did. */
  async function deleteMessage(clientId: string): Promise<Response> {
    if (!CLIENT_ID_RE.test(clientId)) return json({ error: "not found" }, 404);
    const inFlight = routing.get(clientId);
    if (inFlight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([inFlight, new Promise<void>((r) => (timer = setTimeout(r, deps.discardWaitMs ?? DISCARD_WAIT_MS)))]);
      clearTimeout(timer);
      // Still out with the workspace, which may already have it: it can't be called back.
      if (routing.has(clientId)) return json({ routed: true } satisfies DiscardMessageRoutedResponse, 409);
    }
    const row = inbound.get(clientId);
    if (!row) {
      // Its POST may still be on the way; the tombstone makes that POST a 410 instead of a delivery.
      inbound.tombstone(clientId, now());
      return json({ error: "not found" }, 404);
    }
    if (inbound.discard(clientId)) return json({ discarded: true } satisfies DiscardMessageResponse);
    if (row.state === "discarded") return json({ discarded: true } satisfies DiscardMessageResponse);
    return json({ routed: true } satisfies DiscardMessageRoutedResponse, 409);
  }

  async function postStop(req: Request, actor: SurfaceActor): Promise<Response> {
    const body = await parseBody(req, stopBody);
    if (body instanceof Response) return body;
    if (!link.isOwner(actor)) return forbidden();
    void (async () => {
      if (!online()) return notice({ type: "nothingToStop" });
      if (body.turnId) {
        const res = await link.stopTurn(WEB_ORIGIN, body.turnId, actor);
        if (res.status === "failed") notice({ type: "stopFailed", error: res.error });
        else if (res.status === "ok" && res.final) await adapter.progressFinalize(null, { id: body.turnId }, res.final);
        return;
      }
      try {
        if (!(await link.abort()).aborted) notice({ type: "nothingToStop" });
      } catch (err) {
        notice({ type: "stopFailed", error: errorText(err) });
      }
    })().catch((err) => log.error({ err }, "web stop failed"));
    return new Response(null, { status: 202 });
  }

  async function postCommand(req: Request, actor: SurfaceActor): Promise<Response> {
    const body = await parseBody(req, commandBody);
    if (body instanceof Response) return body;
    if (!link.isOwner(actor)) return forbidden();
    void (async () => {
      if (!deps.workspaceEnabled) return notice({ type: "workspaceOffline" });
      if (body.command === "new") {
        if (!link.isConnected()) return notice({ type: "newWhileOffline" });
        try {
          await link.newSession();
          chatLog.append("session", { kind: "new" });
          notice({ type: "newSessionStarted" });
        } catch (err) {
          notice({ type: "newSessionFailed", error: errorText(err) });
        }
        return;
      }
      if (!link.isConnected()) return notice({ type: "commandOffline" });
      try {
        const res = await link.command("compact");
        chatLog.append("session", { kind: "compacted" });
        notice({ type: "commandResult", text: res.text });
      } catch (err) {
        notice({ type: "commandFailed", error: errorText(err) });
      }
    })().catch((err) => log.error({ err }, "web command failed"));
    return new Response(null, { status: 202 });
  }

  async function postAsk(req: Request, askId: string, actor: SurfaceActor): Promise<Response> {
    const body = await parseBody(req, askBody);
    if (body instanceof Response) return body;
    // The adapter keeps askIds unique, so this is the card the owner answered; its own stored choices
    // decide the answer, never the link's in-memory list, which a later ask can overwrite.
    const ask = chatLog.findAsk(askId);
    if (!ask) return json({ error: "unknown ask" }, 404);
    const text = "text" in body ? body.text : ask.data.choices[body.index];
    if (text === undefined) return json({ status: "inactive" } satisfies PostAskResponse);
    const res = await link.answerAsk(WEB_ORIGIN, askId, { text }, actor);
    if (res.status === "forbidden") return forbidden();
    if (res.status === "answered" || res.status === "duplicate") chatLog.append("ask_resolved", { askId, answer: res.answer }, askId);
    // The workspace no longer waits on it, so it must not come back as answerable on the next open.
    else if (res.status === "inactive") chatLog.append("ask_resolved", { askId, answer: null }, askId);
    return json({ status: res.status } satisfies PostAskResponse);
  }

  async function postApproval(req: Request, nonce: string, actor: SurfaceActor): Promise<Response> {
    const body = await parseBody(req, approvalBody);
    if (body instanceof Response) return body;
    // Only a nonce the bot itself posted here can be decided from this route.
    if (!NONCE_RE.test(nonce) || !chatLog.find("approval", nonce)) return json({ error: "unknown approval" }, 404);
    const res = tools.decide(nonce, body.decision, actor);
    if (res === "forbidden") return forbidden();
    return json({ status: res } satisfies PostApprovalResponse);
  }

  async function postSeen(req: Request): Promise<Response> {
    const body = await parseBody(req, seenBody);
    if (body instanceof Response) return body;
    presence.seen(body.seq);
    return new Response(null, { status: 204 });
  }

  function getHistory(req: Request): Response {
    const params = new URL(req.url).searchParams;
    const rawBefore = params.get("before");
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? HISTORY_DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) return json({ error: "invalid limit" }, 400);
    // Imported rows have seqs at or below zero.
    if (rawBefore !== null && !/^-?\d{1,15}$/.test(rawBefore)) return json({ error: "invalid cursor" }, 400);
    const page = historyPage(chatLog, { limit, ...(rawBefore !== null ? { before: Number(rawBefore) } : {}) }, { maxBytes: historyMax, ...(deps.uploads ? { uploads: deps.uploads } : {}) });
    return new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  function getStream(req: Request, server?: { timeout(req: Request, seconds: number): void }): Response {
    // A cross-site page can't read the stream, but a same-origin check keeps it from opening one at all.
    if (req.headers.get("Sec-Fetch-Site") !== "same-origin") return forbidden();
    const after = parseCursor(req);
    if (after === undefined) return json({ error: "invalid cursor" }, 400);
    if (shutdown.signal.aborted) return json({ error: "shutting down" }, 503);
    server?.timeout(req, 0);
    const streamId = crypto.randomUUID();
    return sseResponse(chatLog, after, {
      ...sseTimes,
      onOpen: () => presence.open(streamId),
      hello: () => ({
        workspace: online() ? "online" : "offline",
        openTurns: adapter.openTurns(),
        pending: chatLog.pending({ approvalsSince: now() - APPROVAL_TIMEOUT_MS, asks: PENDING_ASKS_MAX }),
      }),
      signal: AbortSignal.any([req.signal, shutdown.signal]),
    });
  }

  return {
    async handle(req, path, actor, server) {
      if (!path.startsWith("/api/chat/")) return null;
      lastActor = actor;
      if (redriveWanted) redriveUnrouted();
      const method = req.method;
      const sub = path.slice("/api/chat/".length);
      if (sub === "stream") return method === "GET" ? getStream(req, server) : methodNotAllowed();
      if (sub === "history") return method === "GET" ? getHistory(req) : methodNotAllowed();
      const message = /^messages\/([^/]+)$/.exec(sub);
      if (message) return method === "DELETE" ? deleteMessage(decodeSegment(message[1]!) ?? "") : methodNotAllowed();
      if (method !== "POST") return methodNotAllowed();
      if (sub === "messages") return postMessage(req, actor);
      if (sub === "stop") return postStop(req, actor);
      if (sub === "command") return postCommand(req, actor);
      if (sub === "seen") return postSeen(req);
      const ask = /^asks\/([^/]+)$/.exec(sub);
      if (ask) {
        const askId = decodeSegment(ask[1]!);
        return askId ? postAsk(req, askId, actor) : json({ error: "not found" }, 404);
      }
      const approval = /^approvals\/([^/]+)$/.exec(sub);
      if (approval) return postApproval(req, approval[1]!, actor);
      return json({ error: "not found" }, 404);
    },
    closeStreams() {
      shutdown.abort();
    },
    async idle() {
      while (routing.size) await Promise.all([...routing.values()]);
    },
    workspaceConnected() {
      redriveUnrouted();
    },
    async drain(timeoutMs = SHUTDOWN_IDLE_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.idle(), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    },
  };
}

class UploadMissing extends Error {
  constructor(readonly ids: string[]) {
    super("upload missing");
  }
}

async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T, limit?: number): Promise<z.infer<T> | Response> {
  if (!isJson(req)) return json({ error: "content-type must be application/json" }, 415);
  const raw = await readJson(req, limit);
  if (raw instanceof Response) return raw;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid body" }, 400);
  return parsed.data;
}

function decodeSegment(s: string): string | null {
  try {
    const out = decodeURIComponent(s);
    return out && out.length <= ID_MAX ? out : null;
  } catch {
    return null;
  }
}

function methodNotAllowed(): Response {
  return json({ error: "method not allowed" }, 405);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
