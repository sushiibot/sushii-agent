import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { z } from "zod";
import type { WebConfig } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { createPeerMatcher, type PeerMatcher } from "./peers.ts";
import {
  PushSubscriptionStore,
  createPushSender,
  createWebPushTransport,
  setActivePushSender,
  subscriptionSchema,
  type PushSender,
} from "./push.ts";
import { BASE_CSP, HtmlCspCache, cacheControlFor, resolveStatic } from "./static.ts";

const logger = getLogger("web");

const MAX_BODY_BYTES = 8 * 1024;
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

async function readJson(req: Request): Promise<unknown | Response> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
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
    const login = header ?? config.devLogin;
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

export function startWebServer(config: WebConfig, db: Database): Server<undefined> {
  let pushStore: PushSubscriptionStore | undefined;
  let pushSender: PushSender | undefined;
  if (config.push) {
    pushStore = new PushSubscriptionStore(db);
    pushSender = createPushSender(pushStore, createWebPushTransport(config.push));
  }
  setActivePushSender(pushSender);
  if (config.devLogin) logger.warn({ devLogin: config.devLogin }, "WEB_DEV_LOGIN is active: requests without an identity header are treated as this login");
  const handler = createWebHandler({ config, peers: createPeerMatcher(config.trustedPeers), pushStore, pushSender });
  const server = Bun.serve({
    port: config.port,
    hostname: config.bindAddr,
    fetch: (req, srv) => handler(req, srv.requestIP(req)?.address),
  });
  logger.info({ bindAddr: config.bindAddr, port: server.port, trustedPeers: config.trustedPeers, push: Boolean(config.push), distDir: config.distDir }, "web gateway listening");
  return server;
}
