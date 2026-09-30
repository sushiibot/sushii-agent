// The peer-IP check trusts that only the Serve host sends from WEB_TRUSTED_PEERS. Anything with host
// networking or the docker socket on that host counts as the host and can impersonate the owner.
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { z } from "zod";
import { parseWebConfig, type WebConfig } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { createPeerMatcher, isLoopback, type PeerMatcher } from "./peers.ts";
import {
  PushSubscriptionStore,
  checkVapidKeys,
  createPushSender,
  createWebPushTransport,
  setActivePushSender,
  subscriptionSchema,
  type PushSender,
} from "./push.ts";
import { BASE_CSP, HtmlCspCache, cacheControlFor, resolveStatic } from "./static.ts";

const logger = getLogger("web");

const MAX_BODY_BYTES = 8 * 1024;
/** Transport-level ceiling; readJson enforces the real per-route limit while streaming. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const NO_STORE = "no-store";

export interface WebHandlerDeps {
  config: WebConfig;
  peers: PeerMatcher;
  /** Both undefined when push is not configured. */
  pushStore?: PushSubscriptionStore;
  pushSender?: PushSender;
}

export type WebHandler = (req: Request, peerIp: string | null | undefined) => Promise<Response>;

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

function forbidden(): Response {
  return new Response("Forbidden\n", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE } });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": NO_STORE } });
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

const normalizeLogin = (s: string) => s.trim().toLowerCase();

/** Ambient Serve identity makes cross-site writes a CSRF risk, so writes must be same-origin. */
function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  return site !== null ? site === "same-origin" : req.headers.get("Origin") === null;
}

function isJson(req: Request): boolean {
  const type = req.headers.get("Content-Type") ?? "";
  return type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Reads at most `limit` bytes, whether or not the body is chunked; undefined once the limit is exceeded. */
export async function readBodyCapped(req: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: Request): Promise<unknown | Response> {
  const lengthHeader = req.headers.get("Content-Length");
  if (lengthHeader !== null && !(/^\d+$/.test(lengthHeader) && Number(lengthHeader) <= MAX_BODY_BYTES)) {
    return json({ error: "body too large" }, 413);
  }
  const bytes = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!bytes) return json({ error: "body too large" }, 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
}

const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) });

export function createWebHandler(deps: WebHandlerDeps): WebHandler {
  const { config, peers, pushStore, pushSender } = deps;
  const owner = normalizeLogin(config.ownerLogin);
  // Also enforced at parse time; repeated here because a WebConfig can be built without the parser.
  const devLogin = config.devLogin && isLoopback(config.bindAddr) ? config.devLogin : undefined;
  const cspCache = new HtmlCspCache();

  async function api(req: Request, path: string, login: string): Promise<Response> {
    const method = req.method;
    if (method !== "GET" && method !== "HEAD" && !isSameOrigin(req)) return forbidden();

    if (path === "/api/me") {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      const name = req.headers.get("Tailscale-User-Name");
      return json({ login, ...(name ? { displayName: decodeEncodedWords(name) } : {}) });
    }

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
          if (!sub.success) return json({ error: "invalid subscription" }, 400);
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

  return async (req, peerIp) => {
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
    const res = path === "/api" || path.startsWith("/api/") ? await api(req, path, login) : await staticFile(req, path);
    if (!res.headers.has("Content-Security-Policy")) withSecurityHeaders(res);
    return res;
  };
}

/** Replaces Bun's development error page, which echoes the stack to the client. */
export function internalErrorResponse(err: unknown): Response {
  logger.error({ err }, "web request handler threw");
  return withSecurityHeaders(json({ error: "internal" }, 500));
}

export async function startWebServer(config: WebConfig, db: Database): Promise<Server<undefined>> {
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
  const handler = createWebHandler({ config: effective, peers: createPeerMatcher(config.trustedPeers), pushStore, pushSender });
  if (config.devLogin && isLoopback(config.bindAddr)) {
    logger.warn({ devLogin: config.devLogin }, "WEB_DEV_LOGIN is active: requests without an identity header are treated as this login");
  }
  const server = Bun.serve({
    port: config.port,
    hostname: config.bindAddr,
    development: false,
    idleTimeout: 30,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: (req, srv) => handler(req, srv.requestIP(req)?.address),
    error: internalErrorResponse,
  });
  setActivePushSender(pushSender);
  logger.info({ bindAddr: config.bindAddr, port: server.port, trustedPeers: config.trustedPeers, push: Boolean(push), distDir: config.distDir }, "web gateway listening");
  return server;
}

/** Never throws, so a bad web config disables only the web surface. */
export async function startWebGateway(env: Record<string, string | undefined>, db: Database): Promise<Server<undefined> | undefined> {
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
    return await startWebServer(config, db);
  } catch (err) {
    logger.error({ err, bindAddr: config.bindAddr }, "web gateway failed to start");
    return undefined;
  }
}
