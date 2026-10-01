import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import { createPeerMatcher } from "./peers.ts";
import { PushSubscriptionStore, createPushSender, type PushTransport } from "./push.ts";
import { createWebHandler, decodeEncodedWords, internalErrorResponse, readBodyCapped, startWebGateway, startWebServer, type WebHandler } from "./server.ts";

const OWNER = "owner@example.com";
// A P-256 pair in the format the Python key generator emits (X9.62 point, 32-byte scalar); test-only.
const VAPID_PUBLIC = "BHy10boHw8klE_nCp_XOq89c8zCTHnLVb_gNHsUXi3MGqYRQUAd25ezuCGOTaxs01aWZwOQQoMbgWaUCXUaNB2s";
const VAPID_PRIVATE = "oJadJsMeuR-ooTmiXrYzSPYyquwTevs3umnd8bn1axg";
const AUTH = Buffer.alloc(16, 1).toString("base64url");
const AUTH2 = Buffer.alloc(16, 2).toString("base64url");
const INLINE = "globalThis.__boot = 1;";
const INDEX = `<!doctype html><html><head><script type="module" src="/_app/immutable/entry.js"></script></head><body><script>${INLINE}</script></body></html>`;

let root: string;
let dist: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "web-gw-"));
  dist = join(root, "build");
  mkdirSync(join(dist, "_app/immutable"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "_app/immutable/entry.js"), "export {}");
  writeFileSync(join(dist, "service-worker.js"), "self.addEventListener('push', () => {})");
  writeFileSync(join(dist, "about.html"), "<!doctype html><p>about</p>");
  writeFileSync(join(root, "secret.txt"), "top secret");
  writeFileSync(join(root, "build-other.txt"), "sibling");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/leak.txt"), "outside leak");
  symlinkSync(join(root, "secret.txt"), join(dist, "linked.txt"));
  symlinkSync(join(root, "outside"), join(dist, "linkdir"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function webConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    port: 0,
    bindAddr: "127.0.0.1",
    ownerLogin: OWNER,
    distDir: dist,
    devLogin: undefined,
    trustedPeers: ["172.31.250.1"],
    push: { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: "mailto:x@example.com" },
    ...overrides,
  };
}

function setup(overrides: Partial<WebConfig> = {}, transport: PushTransport = async () => 201) {
  const db = new Database(":memory:");
  applySchema(db);
  const pushStore = new PushSubscriptionStore(db);
  const config = webConfig(overrides);
  const handler = createWebHandler({
    config,
    peers: createPeerMatcher(config.trustedPeers),
    ...(config.push ? { pushStore, pushSender: createPushSender(pushStore, transport) } : {}),
  });
  return { handler, pushStore };
}

const GW = "172.31.250.1";

function req(path: string, init: RequestInit & { login?: string | null } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.login !== null) headers.set("Tailscale-User-Login", init.login ?? OWNER);
  return new Request(`http://apps.example.ts.net${path}`, { ...init, headers });
}

function jsonWrite(path: string, method: string, body: unknown, extra: Record<string, string> = {}): Request {
  return req(path, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...extra },
  });
}

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/sub-1", expirationTime: null, keys: { p256dh: VAPID_PUBLIC, auth: AUTH } };

describe("auth", () => {
  let handler: WebHandler;
  beforeAll(() => ({ handler } = setup()));

  test("an untrusted peer gets 403 even with the owner header", async () => {
    for (const peer of ["172.18.0.5", "172.31.250.3", "172.31.250.2", "127.0.0.1", "100.100.1.1", null, undefined]) {
      const res = await handler(req("/"), peer);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden\n");
      const api = await handler(req("/api/me"), peer);
      expect(api.status).toBe(403);
    }
  });

  test("a trusted peer with the wrong or missing login gets 403", async () => {
    expect((await handler(req("/", { login: "someone@example.com" }), GW)).status).toBe(403);
    expect((await handler(req("/api/me", { login: null }), GW)).status).toBe(403);
    expect((await handler(req("/api/me", { login: "" }), GW)).status).toBe(403);
  });

  test("a trusted peer with the owner login gets through", async () => {
    const res = await handler(req("/api/me", { headers: { "Tailscale-User-Name": "=?utf-8?q?J=C3=BCrgen_Owner?=" } }), GW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: OWNER, displayName: "Jürgen Owner", features: [] });
    expect((await handler(req("/", { login: "Owner@Example.com" }), `::ffff:${GW}`)).status).toBe(200);
  });

  test("the dev login stands in for a missing header only when configured", async () => {
    const dev = setup({ devLogin: OWNER, trustedPeers: ["127.0.0.1"] }).handler;
    expect((await dev(req("/api/me", { login: null }), "127.0.0.1")).status).toBe(200);
    expect((await dev(req("/api/me", { login: "other@example.com" }), "127.0.0.1")).status).toBe(403);
    expect((await dev(req("/api/me", { login: null }), GW)).status).toBe(403);
  });

  test("the dev login is ignored unless the server binds to loopback", async () => {
    const offLoopback = setup({ devLogin: OWNER, bindAddr: "172.31.250.2", trustedPeers: [GW] }).handler;
    expect((await offLoopback(req("/api/me", { login: null }), GW)).status).toBe(403);
    const { parseWebConfig } = await import("../../config.ts");
    expect(parseWebConfig({ WEB_OWNER_LOGIN: OWNER, WEB_DEV_LOGIN: OWNER, WEB_BIND_ADDR: "172.31.250.2" })?.devLogin).toBeUndefined();
    expect(parseWebConfig({ WEB_OWNER_LOGIN: OWNER, WEB_DEV_LOGIN: OWNER, NODE_ENV: "Production" })?.devLogin).toBeUndefined();
  });

  test("the dev login is ignored in production", async () => {
    const { parseWebConfig } = await import("../../config.ts");
    const prod = parseWebConfig({ WEB_OWNER_LOGIN: OWNER, WEB_DEV_LOGIN: OWNER, NODE_ENV: "production", WEB_DIST_DIR: dist, WEB_TRUSTED_PEERS: "127.0.0.1" })!;
    const h = setup(prod).handler;
    expect((await h(req("/api/me", { login: null }), "127.0.0.1")).status).toBe(403);
  });

  test("/api/me lists the features WEB_FEATURES turns on", async () => {
    const h = setup({ features: ["runs", "home"] }).handler;
    expect(await (await h(req("/api/me"), GW)).json()).toEqual({ login: OWNER, features: ["runs", "home"] });
  });

  test("WEB_FEATURES: known names only, in a fixed order, never throwing", async () => {
    const { parseWebFeatures, parseWebConfig } = await import("../../config.ts");
    const warned: unknown[] = [];
    const warn = (ctx: Record<string, unknown>) => void warned.push(ctx.feature);
    expect(parseWebFeatures(" Alerts, runs,,bogus,runs ,history", warn)).toEqual(["runs", "history", "alerts"]);
    expect(warned).toEqual(["bogus"]);
    expect(parseWebFeatures(undefined, warn)).toEqual([]);
    expect(parseWebFeatures("", warn)).toEqual([]);
    expect(parseWebConfig({ WEB_OWNER_LOGIN: OWNER, WEB_FEATURES: "home" })?.features).toEqual(["home"]);
    expect(parseWebConfig({ WEB_OWNER_LOGIN: OWNER })?.features).toEqual([]);
  });

  test("every response carries the security headers", async () => {
    for (const res of [await handler(req("/"), GW), await handler(req("/api/me"), GW), await handler(req("/"), "8.8.8.8")]) {
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    }
  });
});

describe("static", () => {
  let handler: WebHandler;
  beforeAll(() => ({ handler } = setup()));

  test("serves index with no-cache and a CSP hash for its inline script", async () => {
    const res = await handler(req("/"), GW);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const hash = createHash("sha256").update(INLINE).digest("base64");
    expect(res.headers.get("Content-Security-Policy")).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(res.headers.get("Content-Security-Policy")).not.toContain("unsafe-eval");
  });

  test("hashed assets are immutable; the service worker is no-cache", async () => {
    const asset = await handler(req("/_app/immutable/entry.js"), GW);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const sw = await handler(req("/service-worker.js"), GW);
    expect(sw.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("SPA fallback for client routes, 404 for missing files", async () => {
    const route = await handler(req("/threads/abc"), GW);
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(INDEX);
    expect(route.headers.get("Cache-Control")).toBe("no-cache");
    const csp = route.headers.get("Content-Security-Policy")!;
    expect(csp).toContain(`'sha256-${createHash("sha256").update(INLINE).digest("base64")}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
    expect((await handler(req("/about"), GW)).status).toBe(200);
    const missing = await handler(req("/_app/immutable/gone.js"), GW);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).not.toContain("immutable");
    expect((await handler(req("/.env"), GW)).status).toBe(404);
  });

  test("path traversal never leaves the dist dir", async () => {
    // A hand-built Request keeps encoded separators; fetch clients would normalize them away.
    for (const path of ["/..%2fsecret.txt", "/..%2F..%2Fsecret.txt", "/%2e%2e%2fsecret.txt", "/..%5csecret.txt", "/foo%00.html", "/%2e%2e/build-other.txt"]) {
      const res = await handler(new Request(`http://x${path}`, { headers: { "Tailscale-User-Login": OWNER } }), GW);
      const body = await res.text();
      expect(body).not.toContain("top secret");
      expect(body).not.toContain("sibling");
      expect([400, 404, 200]).toContain(res.status);
    }
    const res = await handler(new Request("http://x/..%2fsecret.txt", { headers: { "Tailscale-User-Login": OWNER } }), GW);
    expect(res.status).toBe(400);
  });

  test("symlinks pointing outside the dist dir are not served", async () => {
    for (const path of ["/linked.txt", "/linkdir/leak.txt"]) {
      const res = await handler(req(path), GW);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("top secret");
      expect(body).not.toContain("outside leak");
    }
  });

  test("unknown /api paths are JSON 404s, not the SPA", async () => {
    const res = await handler(req("/api/nope"), GW);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("push api", () => {
  test("key, subscribe upsert, unsubscribe", async () => {
    const { handler, pushStore } = setup();
    expect(await (await handler(req("/api/push/key"), GW)).json()).toEqual({ publicKey: VAPID_PUBLIC });

    expect(await (await handler(jsonWrite("/api/push/subscribe", "POST", SUB), GW)).json()).toEqual({ ok: true });
    await handler(jsonWrite("/api/push/subscribe", "POST", { ...SUB, keys: { ...SUB.keys, auth: AUTH2 } }), GW);
    expect(pushStore.list()).toHaveLength(1);
    expect(pushStore.list()[0]!.auth).toBe(AUTH2);

    expect(await (await handler(jsonWrite("/api/push/subscribe", "DELETE", { endpoint: SUB.endpoint }), GW)).json()).toEqual({ ok: true });
    expect(pushStore.list()).toHaveLength(0);
  });

  test("rejects invalid subscriptions", async () => {
    const { handler, pushStore } = setup();
    for (const bad of [
      { ...SUB, endpoint: "http://fcm.googleapis.com/fcm/send/1" },
      { ...SUB, endpoint: "https://127.0.0.1:8787/x" },
      { ...SUB, keys: { ...SUB.keys, p256dh: "cDI1NmRo" } },
      { ...SUB, keys: { ...SUB.keys, auth: "YXV0aA" } },
      // The right length and prefix, but not a point on P-256.
      { ...SUB, keys: { ...SUB.keys, p256dh: Buffer.from([4, ...new Array(64).fill(1)]).toString("base64url") } },
      { endpoint: SUB.endpoint },
      "nope",
    ]) {
      expect((await handler(jsonWrite("/api/push/subscribe", "POST", bad), GW)).status).toBe(400);
    }
    const huge = { ...SUB, pad: "x".repeat(10_000) };
    expect((await handler(jsonWrite("/api/push/subscribe", "POST", huge), GW)).status).toBe(413);
    expect(pushStore.list()).toHaveLength(0);
  });

  test("the body limit holds for chunked bodies and bad Content-Length values", async () => {
    const { handler, pushStore } = setup();
    let pulled = 0;
    const chunk = new TextEncoder().encode(" ".repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 1000) c.close();
        else c.enqueue(chunk);
      },
    });
    const chunked = req("/api/push/subscribe", {
      method: "POST",
      body: stream,
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    });
    expect(chunked.headers.get("Content-Length")).toBeNull();
    expect((await handler(chunked, GW)).status).toBe(413);
    expect(pulled).toBeLessThan(20);

    const bogusLength = jsonWrite("/api/push/subscribe", "POST", SUB, { "Content-Length": "abc" });
    expect((await handler(bogusLength, GW)).status).toBe(413);
    expect(pushStore.list()).toHaveLength(0);
  });

  test("readBodyCapped returns the body under the cap and undefined over it", async () => {
    expect(new TextDecoder().decode(await readBodyCapped(new Request("http://x", { method: "POST", body: "abc" }), 3))).toBe("abc");
    expect(await readBodyCapped(new Request("http://x", { method: "POST", body: "abcd" }), 3)).toBeUndefined();
  });

  test("cross-site or non-JSON writes are refused", async () => {
    const { handler, pushStore } = setup();
    const cases = [
      jsonWrite("/api/push/subscribe", "POST", SUB, { "Sec-Fetch-Site": "cross-site" }),
      jsonWrite("/api/push/subscribe", "POST", SUB, { "Sec-Fetch-Site": "same-site" }),
      req("/api/push/subscribe", { method: "POST", body: JSON.stringify(SUB), headers: { "Content-Type": "application/json", Origin: "https://evil.example" } }),
      jsonWrite("/api/push/test", "POST", {}, { "Sec-Fetch-Site": "cross-site" }),
    ];
    for (const r of cases) expect((await handler(r, GW)).status).toBe(403);
    expect((await handler(jsonWrite("/api/push/subscribe", "POST", SUB, { "Content-Type": "text/plain" }), GW)).status).toBe(415);
    expect(pushStore.list()).toHaveLength(0);
  });

  test("test send reports sent and prunes 410s", async () => {
    const transport: PushTransport = async (s) => (s.endpoint.endsWith("/gone") ? 410 : 201);
    const { handler, pushStore } = setup({}, transport);
    await handler(jsonWrite("/api/push/subscribe", "POST", SUB), GW);
    await handler(jsonWrite("/api/push/subscribe", "POST", { ...SUB, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gone" }), GW);
    const res = await handler(req("/api/push/test", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } }), GW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, pruned: 1 });
    expect(pushStore.list().map((s) => s.endpoint)).toEqual([SUB.endpoint]);
  });

  test("push endpoints are off without VAPID keys, the rest still works", async () => {
    const { handler } = setup({ push: undefined });
    expect((await handler(req("/api/push/key"), GW)).status).toBe(404);
    expect((await handler(jsonWrite("/api/push/subscribe", "POST", SUB), GW)).status).toBe(404);
    expect((await handler(req("/api/me"), GW)).status).toBe(200);
  });
});

describe("decodeEncodedWords", () => {
  test("decodes Q and B words and leaves plain text alone", () => {
    expect(decodeEncodedWords("Plain Name")).toBe("Plain Name");
    expect(decodeEncodedWords("=?UTF-8?B?SsO8cmdlbg==?=")).toBe("Jürgen");
  });
});

describe("startWebServer", () => {
  test("uses the socket peer: loopback passes, and a raw traversal request is refused", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const server = await startWebServer(webConfig({ push: undefined, trustedPeers: ["127.0.0.1"] }), db);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/me`, { headers: { "Tailscale-User-Login": OWNER } })).status).toBe(200);
      expect((await fetch(`${base}/api/me`)).status).toBe(403);

      const raw = await new Promise<string>((resolve, reject) => {
        let out = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: server.port!,
          socket: {
            open(s) {
              s.write(`GET /../secret.txt HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${OWNER}\r\nConnection: close\r\n\r\n`);
            },
            data(_s, d) {
              out += d.toString();
            },
            close() {
              resolve(out);
            },
            error(_s, e) {
              reject(e);
            },
          },
        });
      });
      expect(raw).not.toContain("top secret");
    } finally {
      server.stop(true);
    }
  });

  test("an allowlist without loopback refuses a loopback peer", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const server = await startWebServer(webConfig({ push: undefined, trustedPeers: ["172.31.250.1"] }), db);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/me`, { headers: { "Tailscale-User-Login": OWNER } });
      expect(res.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});

describe("internalErrorResponse", () => {
  test("is a bare JSON 500 with the security headers, never the error text", async () => {
    const res = internalErrorResponse(new Error("secret stack detail"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

describe("startWebGateway", () => {
  const baseEnv = () => ({ WEB_OWNER_LOGIN: OWNER, WEB_DIST_DIR: dist, WEB_BIND_ADDR: "127.0.0.1", WEB_TRUSTED_PEERS: "127.0.0.1" });
  const vapid = { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE, VAPID_SUBJECT: "mailto:x@example.com" };
  const freshDb = () => {
    const db = new Database(":memory:");
    applySchema(db);
    return db;
  };

  async function pushKeyStatus(env: Record<string, string>): Promise<{ key: number; me: number }> {
    const server = await startWebGateway({ ...env, WEB_PORT: String(await freePort()) }, freshDb());
    expect(server).toBeDefined();
    try {
      const base = `http://127.0.0.1:${server!.port}`;
      const headers = { "Tailscale-User-Login": OWNER };
      return { key: (await fetch(`${base}/api/push/key`, { headers })).status, me: (await fetch(`${base}/api/me`, { headers })).status };
    } finally {
      await server!.stop(true);
    }
  }

  test("a Python-generated VAPID pair turns push on", async () => {
    expect(await pushKeyStatus({ ...baseEnv(), ...vapid })).toEqual({ key: 200, me: 200 });
  });

  test("a bad VAPID setup turns push off but keeps the gateway up", async () => {
    const other = Buffer.from(await crypto.subtle.exportKey("raw", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).publicKey)).toString("base64url");
    const cases: Record<string, string>[] = [
      { VAPID_PUBLIC_KEY: VAPID_PUBLIC },
      { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE },
      { ...vapid, VAPID_PUBLIC_KEY: other },
      { ...vapid, VAPID_PRIVATE_KEY: Buffer.alloc(31, 7).toString("base64url") },
      { ...vapid, VAPID_PRIVATE_KEY: `${VAPID_PRIVATE}=` },
      { ...vapid, VAPID_PUBLIC_KEY: VAPID_PUBLIC.slice(0, 40) },
    ];
    for (const extra of cases) expect(await pushKeyStatus({ ...baseEnv(), ...extra })).toEqual({ key: 404, me: 200 });
  });

  test("an invalid gateway setting disables the web gateway without throwing", async () => {
    for (const bad of [{ WEB_PORT: "nope" }, { WEB_TRUSTED_PEERS: "172.31.250.0/24" }, { WEB_BIND_ADDR: "localhost" }]) {
      expect(await startWebGateway({ ...baseEnv(), ...bad }, freshDb())).toBeUndefined();
    }
    expect(await startWebGateway({}, freshDb())).toBeUndefined();
  });
});
