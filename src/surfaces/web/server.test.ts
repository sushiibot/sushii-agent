import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import { createPeerMatcher } from "./peers.ts";
import { PushSubscriptionStore, createPushSender, type PushTransport } from "./push.ts";
import { createWebHandler, decodeEncodedWords, startWebServer, type WebHandler } from "./server.ts";

const OWNER = "owner@example.com";
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
    push: { publicKey: "BPUB", privateKey: "PRIV", subject: "mailto:x@example.com" },
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

const SUB = { endpoint: "https://push.example/sub/1", expirationTime: null, keys: { p256dh: "cDI1NmRo", auth: "YXV0aA" } };

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
    expect(await res.json()).toEqual({ login: OWNER, displayName: "Jürgen Owner" });
    expect((await handler(req("/", { login: "Owner@Example.com" }), `::ffff:${GW}`)).status).toBe(200);
  });

  test("the dev login stands in for a missing header only when configured", async () => {
    const dev = setup({ devLogin: OWNER, trustedPeers: ["127.0.0.1"] }).handler;
    expect((await dev(req("/api/me", { login: null }), "127.0.0.1")).status).toBe(200);
    expect((await dev(req("/api/me", { login: "other@example.com" }), "127.0.0.1")).status).toBe(403);
    expect((await dev(req("/api/me", { login: null }), GW)).status).toBe(403);
  });

  test("the dev login is ignored in production", async () => {
    const { parseWebConfig } = await import("../../config.ts");
    const prod = parseWebConfig({ WEB_OWNER_LOGIN: OWNER, WEB_DEV_LOGIN: OWNER, NODE_ENV: "production", WEB_DIST_DIR: dist, WEB_TRUSTED_PEERS: "127.0.0.1" })!;
    const h = setup(prod).handler;
    expect((await h(req("/api/me", { login: null }), "127.0.0.1")).status).toBe(403);
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

  test("unknown /api paths are JSON 404s, not the SPA", async () => {
    const res = await handler(req("/api/nope"), GW);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("push api", () => {
  test("key, subscribe upsert, unsubscribe", async () => {
    const { handler, pushStore } = setup();
    expect(await (await handler(req("/api/push/key"), GW)).json()).toEqual({ publicKey: "BPUB" });

    expect(await (await handler(jsonWrite("/api/push/subscribe", "POST", SUB), GW)).json()).toEqual({ ok: true });
    await handler(jsonWrite("/api/push/subscribe", "POST", { ...SUB, keys: { ...SUB.keys, auth: "bmV3" } }), GW);
    expect(pushStore.list()).toHaveLength(1);
    expect(pushStore.list()[0]!.auth).toBe("bmV3");

    expect(await (await handler(jsonWrite("/api/push/subscribe", "DELETE", { endpoint: SUB.endpoint }), GW)).json()).toEqual({ ok: true });
    expect(pushStore.list()).toHaveLength(0);
  });

  test("rejects invalid subscriptions", async () => {
    const { handler, pushStore } = setup();
    for (const bad of [{ ...SUB, endpoint: "http://push.example/1" }, { endpoint: SUB.endpoint }, "nope"]) {
      expect((await handler(jsonWrite("/api/push/subscribe", "POST", bad), GW)).status).toBe(400);
    }
    const huge = { ...SUB, pad: "x".repeat(10_000) };
    expect((await handler(jsonWrite("/api/push/subscribe", "POST", huge), GW)).status).toBe(413);
    expect(pushStore.list()).toHaveLength(0);
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
    await handler(jsonWrite("/api/push/subscribe", "POST", { ...SUB, endpoint: "https://push.example/gone" }), GW);
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
    const server = startWebServer(webConfig({ push: undefined, trustedPeers: ["127.0.0.1"] }), db);
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

  test("the default allowlist refuses loopback", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const server = startWebServer(webConfig({ push: undefined, trustedPeers: ["172.31.250.1"] }), db);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/me`, { headers: { "Tailscale-User-Login": OWNER } });
      expect(res.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});
