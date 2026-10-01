// The peer-IP check trusts that only the Serve host sends from WEB_TRUSTED_PEERS. Anything with host
// networking or the docker socket on that host counts as the host and can impersonate the owner.
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { z } from "zod";
import { parseWebConfig, type WebConfig } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";
import { mintWebActor, normalizeLogin } from "./actor.ts";
import type { ChatRoutes } from "./chatRoutes.ts";
import type { MeResponse } from "./events.ts";
import { createReadRoutes, type ReadRouteDeps, type ReadRoutes } from "./readRoutes.ts";
import { createPeerMatcher, isLoopback, type PeerMatcher } from "./peers.ts";
import {
  PushSubscriptionStore,
  checkVapidKeys,
  createPushSender,
  createWebPushTransport,
  setActivePushSender,
  subscriptionKeysUsable,
  subscriptionSchema,
  type PushSender,
} from "./push.ts";
import { NO_STORE, forbidden, isJson, isSameOrigin, json, readJson } from "./http.ts";
import { BASE_CSP, HtmlCspCache, cacheControlFor, resolveStatic } from "./static.ts";
import { handleFileGet, handleUploadPost } from "./uploadRoutes.ts";
import { scheduleUploadGc, type DiskUploadStore } from "./uploads.ts";

export { readBodyCapped } from "./http.ts";

const logger = getLogger("web");

/** Transport-level ceiling, sized for uploads; each route enforces its own cap while streaming. */
const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024;

export interface WebHandlerDeps {
  config: WebConfig;
  peers: PeerMatcher;
  /** Both undefined when push is not configured. */
  pushStore?: PushSubscriptionStore;
  pushSender?: PushSender;
  /** Absent: /api/uploads and /f/ answer 404. */
  uploads?: DiskUploadStore;
  /** The /api/chat routes; absent when the chat surface is not wired. */
  chat?: ChatRoutes;
  /** /api/runs, /api/history and /api/search; absent: they answer 404. */
  reads?: ReadRoutes;
}

/** The slice of Bun's server a route may use: lifting the idle timeout for a stream. */
export type RequestTimeouts = { timeout(req: Request, seconds: number): void };

export type WebHandler = (req: Request, peerIp: string | null | undefined, server?: RequestTimeouts) => Promise<Response>;

function withSecurityHeaders(res: Response, csp = BASE_CSP): Response {
  const h = res.headers;
  h.set("Content-Security-Policy", csp);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

/** Decodes RFC 2047 encoded-words, which Serve uses for non-ASCII identity header values. */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toUpperCase() === "B"
          ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
          : Uint8Array.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
              (c) => c.charCodeAt(0),
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
}

const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) });

export function createWebHandler(deps: WebHandlerDeps): WebHandler {
  const { config, peers, pushStore, pushSender, uploads, chat, reads } = deps;
  const owner = normalizeLogin(config.ownerLogin);
  // Also enforced at parse time; repeated here because a WebConfig can be built without the parser.
  const devLogin = config.devLogin && isLoopback(config.bindAddr) ? config.devLogin : undefined;
  const cspCache = new HtmlCspCache();

  /** `actor` is the only identity a route may hand to the workspace's owner checks. */
  async function api(req: Request, path: string, login: string, actor: SurfaceActor, server?: RequestTimeouts): Promise<Response> {
    const method = req.method;
    if (method === "GET" || method === "HEAD") {
      // Fetch Metadata: a browser always sends it, so only a non-browser client may omit it.
      const site = req.headers.get("Sec-Fetch-Site");
      if (site !== null && site !== "same-origin") return forbidden();
    } else if (!isSameOrigin(req)) return forbidden();

    if (chat) {
      const res = await chat.handle(req, path, actor, server);
      if (res) return res;
    }
    if (reads) {
      const res = await reads.handle(req, path);
      if (res) return res;
    }

    if (path === "/api/me") {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      const name = req.headers.get("Tailscale-User-Name");
      return json({ login, ...(name ? { displayName: decodeEncodedWords(name) } : {}), features: config.features ?? [] } satisfies MeResponse);
    }

    if (path === "/api/uploads") return uploads ? handleUploadPost(req, uploads) : json({ error: "not found" }, 404);

    if (path.startsWith("/api/push/")) {
      if (!pushStore || !pushSender || !config.push) return json({ error: "push is not configured" }, 404);
      if (path === "/api/push/key") {
        if (method !== "GET") return json({ error: "method not allowed" }, 405);
        return json({ publicKey: config.push.publicKey });
      }
      if (path === "/api/push/subscribe") {
        if (method !== "POST" && method !== "DELETE") return json({ error: "method not allowed" }, 405);
        // A JSON content type also rules out CORS-simple cross-site bodies from older browsers.
        if (!isJson(req)) return json({ error: "content-type must be application/json" }, 415);
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (method === "POST") {
          const sub = subscriptionSchema.safeParse(body);
          if (!sub.success || !(await subscriptionKeysUsable(sub.data.keys))) return json({ error: "invalid subscription" }, 400);
          pushStore.upsert(sub.data);
          return json({ ok: true });
        }
        const unsub = unsubscribeSchema.safeParse(body);
        if (!unsub.success) return json({ error: "invalid body" }, 400);
        pushStore.remove(unsub.data.endpoint);
        return json({ ok: true });
      }
      if (path === "/api/push/test") {
        if (method !== "POST") return json({ error: "method not allowed" }, 405);
        const { sent, pruned } = await pushSender.send({ title: "Test notification", body: "Push notifications are working.", url: "/" });
        return json({ sent, pruned });
      }
    }
    return json({ error: "not found" }, 404);
  }

  async function staticFile(req: Request, path: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const hit = resolveStatic(config.distDir, path);
    if (hit.kind === "bad-request") return new Response("Bad Request\n", { status: 400 });
    if (hit.kind === "not-found") return new Response("Not Found\n", { status: 404, headers: { "Cache-Control": NO_STORE } });
    const file = Bun.file(hit.path);
    const res = new Response(file, { headers: { "Cache-Control": cacheControlFor(path, hit.fallback) } });
    if (hit.path.endsWith(".html")) return withSecurityHeaders(res, await cspCache.get(hit.path));
    return res;
  }

  return async (req, peerIp, server) => {
    if (!peers(peerIp)) {
      logger.warn({ peer: peerIp ?? null }, "web request from untrusted peer rejected");
      return withSecurityHeaders(forbidden());
    }
    const header = req.headers.get("Tailscale-User-Login");
    const login = header ?? devLogin;
    if (!login || normalizeLogin(login) !== owner) {
      logger.warn({ peer: peerIp, login: login ?? null }, "web request with non-owner login rejected");
      return withSecurityHeaders(forbidden());
    }

    const path = new URL(req.url).pathname;
    let res: Response;
    if (path === "/api" || path.startsWith("/api/")) {
      const name = req.headers.get("Tailscale-User-Name");
      res = await api(req, path, login, mintWebActor(login, name ? decodeEncodedWords(name) : undefined), server);
    } else if (path === "/f" || path.startsWith("/f/")) {
      res = uploads ? await handleFileGet(req, path, uploads) : json({ error: "not found" }, 404);
    } else res = await staticFile(req, path);
    if (!res.headers.has("Content-Security-Policy")) withSecurityHeaders(res);
    return res;
  };
}

/** Replaces Bun's development error page, which echoes the stack to the client. */
export function internalErrorResponse(err: unknown): Response {
  logger.error({ err }, "web request handler threw");
  return withSecurityHeaders(json({ error: "internal" }, 500));
}

export interface WebServerOptions {
  uploads?: DiskUploadStore;
  chat?: ChatRoutes;
  /** Sources for the read-only routes; the gateway gates them on its WEB_FEATURES. */
  reads?: Omit<ReadRouteDeps, "features">;
}

export async function startWebServer(config: WebConfig, db: Database, opts: WebServerOptions = {}): Promise<Server<undefined>> {
  let pushStore: PushSubscriptionStore | undefined;
  let pushSender: PushSender | undefined;
  let push = config.push;
  if (config.pushDisabledReason) logger.error({ reason: config.pushDisabledReason }, "web push disabled: invalid VAPID config");
  if (push) {
    const problem = await checkVapidKeys(push);
    if (problem) {
      logger.error({ reason: problem }, "web push disabled: invalid VAPID config");
      push = undefined;
    }
  }
  if (push) {
    pushStore = new PushSubscriptionStore(db);
    pushSender = createPushSender(pushStore, createWebPushTransport(push));
  }
  const effective: WebConfig = { ...config, push };
  const handler = createWebHandler({
    config: effective,
    peers: createPeerMatcher(config.trustedPeers),
    pushStore,
    pushSender,
    ...(opts.uploads ? { uploads: opts.uploads } : {}),
    ...(opts.chat ? { chat: opts.chat } : {}),
    ...(opts.reads ? { reads: createReadRoutes({ ...opts.reads, features: config.features ?? [] }) } : {}),
  });
  if (config.devLogin && isLoopback(config.bindAddr)) {
    logger.warn({ devLogin: config.devLogin }, "WEB_DEV_LOGIN is active: requests without an identity header are treated as this login");
  }
  const server = Bun.serve({
    port: config.port,
    hostname: config.bindAddr,
    development: false,
    idleTimeout: 30,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: (req, srv) => handler(req, srv.requestIP(req)?.address, srv),
    error: internalErrorResponse,
  });
  setActivePushSender(pushSender);
  if (opts.uploads) scheduleUploadGc(opts.uploads);
  logger.info({ bindAddr: config.bindAddr, port: server.port, trustedPeers: config.trustedPeers, push: Boolean(push), distDir: config.distDir }, "web gateway listening");
  return server;
}

/** Never throws, so a bad web config disables only the web surface. */
export async function startWebGateway(env: Record<string, string | undefined>, db: Database, opts: WebServerOptions = {}): Promise<Server<undefined> | undefined> {
  let config: WebConfig | undefined;
  try {
    config = parseWebConfig(env);
  } catch (err) {
    logger.error({ err }, "web gateway disabled: invalid web config");
    return undefined;
  }
  if (!config) {
    logger.info("WEB_OWNER_LOGIN not set — web gateway disabled");
    return undefined;
  }
  try {
    return await startWebServer(config, db, opts);
  } catch (err) {
    logger.error({ err, bindAddr: config.bindAddr }, "web gateway failed to start");
    return undefined;
  }
}
