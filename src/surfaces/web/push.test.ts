import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import {
  MAX_PAYLOAD_BYTES,
  PushSubscriptionStore,
  checkVapidKeys,
  createPushSender,
  createWebPushTransport,
  fitPayload,
  isAllowedPushEndpoint,
  sendPush,
  setActivePushSender,
  subscriptionSchema,
  UnusableSubscriptionError,
  type PushTransport,
} from "./push.ts";

// A P-256 pair in the format the Python key generator emits (X9.62 point, 32-byte scalar); test-only.
const PY_VAPID = {
  publicKey: "BHy10boHw8klE_nCp_XOq89c8zCTHnLVb_gNHsUXi3MGqYRQUAd25ezuCGOTaxs01aWZwOQQoMbgWaUCXUaNB2s",
  privateKey: "oJadJsMeuR-ooTmiXrYzSPYyquwTevs3umnd8bn1axg",
  subject: "mailto:test@example.com",
};

function store(max?: number): PushSubscriptionStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new PushSubscriptionStore(db, max);
}

const sub = (n: number, auth = "YXV0aA") => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "cDI1NmRo", auth } });

describe("PushSubscriptionStore", () => {
  test("upserts by endpoint and removes", () => {
    const s = store();
    s.upsert(sub(1), 1000);
    s.upsert(sub(1, "bmV3"), 2000);
    s.upsert(sub(2), 3000);
    const rows = s.list();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.endpoint.endsWith("/1"))).toMatchObject({ auth: "bmV3", createdAt: 1000, lastOkAt: null });
    s.remove(sub(1).endpoint);
    expect(s.list().map((r) => r.endpoint)).toEqual([sub(2).endpoint]);
  });
});

describe("subscription cap", () => {
  test("a new endpoint at the cap evicts the least recently delivered-to subscription", () => {
    const s = store(3);
    s.upsert(sub(1), 1000);
    s.upsert(sub(2), 2000);
    s.upsert(sub(3), 3000);
    s.markOk(sub(1).endpoint, 5000);
    s.upsert(sub(4), 6000);
    expect(s.list().map((r) => r.endpoint).sort()).toEqual([sub(1), sub(3), sub(4)].map((x) => x.endpoint));
  });

  test("re-upserting an existing endpoint at the cap evicts nothing", () => {
    const s = store(2);
    s.upsert(sub(1), 1000);
    s.upsert(sub(2), 2000);
    s.upsert(sub(1, "bmV3"), 3000);
    expect(s.list()).toHaveLength(2);
  });
});

describe("subscription validation", () => {
  const p256dh = PY_VAPID.publicKey;
  const auth = Buffer.alloc(16, 9).toString("base64url");

  test("only https endpoints on known push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://api.push.apple.com/3/device/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isAllowedPushEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.com/x",
      "https://evilnotify.windows.com/x",
      "https://push.apple.com.evil.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest",
      "https://fcm.googleapis.com./x",
      "not a url",
    ]) {
      expect(isAllowedPushEndpoint(bad)).toBe(false);
    }
  });

  test("p256dh must be a 65-byte point and auth 16 bytes", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(subscriptionSchema.safeParse({ endpoint, keys: { p256dh, auth } }).success).toBe(true);
    expect(subscriptionSchema.safeParse({ endpoint, keys: { p256dh, auth: `${auth}==` } }).success).toBe(true);
    const compressed = Buffer.from(p256dh, "base64url");
    compressed[0] = 0x02;
    for (const keys of [
      { p256dh: "cDI1NmRo", auth },
      { p256dh: compressed.toString("base64url"), auth },
      { p256dh, auth: Buffer.alloc(15).toString("base64url") },
      { p256dh, auth: "not+base64/url" },
    ]) {
      expect(subscriptionSchema.safeParse({ endpoint, keys }).success).toBe(false);
    }
  });
});

describe("checkVapidKeys", () => {
  test("accepts a Python-generated pair", async () => {
    expect(await checkVapidKeys(PY_VAPID)).toBeUndefined();
  });

  test("rejects a mismatched pair, a short scalar and padding", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const otherPub = Buffer.from(await crypto.subtle.exportKey("raw", other.publicKey)).toString("base64url");
    expect(await checkVapidKeys({ ...PY_VAPID, publicKey: otherPub })).toContain("failed to import");
    expect(await checkVapidKeys({ ...PY_VAPID, privateKey: Buffer.alloc(31, 1).toString("base64url") })).toContain("32 bytes");
    expect(await checkVapidKeys({ ...PY_VAPID, privateKey: `${PY_VAPID.privateKey}=` })).toContain("padding");
  });
});

describe("createPushSender", () => {
  test("counts sends, prunes 404/410, keeps other failures", async () => {
    const s = store();
    for (const n of [1, 2, 3, 4, 5, 6]) s.upsert(sub(n));
    const statuses: Record<string, number | Error> = {
      "https://push.example/1": 201,
      "https://push.example/2": 410,
      "https://push.example/3": 404,
      "https://push.example/4": 500,
      "https://push.example/5": new Error("timeout"),
      "https://push.example/6": 307,
    };
    const seen: string[] = [];
    const transport: PushTransport = async (target, data) => {
      seen.push(data);
      const r = statuses[target.endpoint]!;
      if (r instanceof Error) throw r;
      return r;
    };
    const result = await createPushSender(s, transport).send({ title: "t", body: "b", url: "/" });
    expect(result).toEqual({ sent: 1, pruned: 2, failed: 3 });
    expect(s.list().map((r) => r.endpoint).sort()).toEqual(["https://push.example/1", "https://push.example/4", "https://push.example/5", "https://push.example/6"]);
    expect(s.list().find((r) => r.endpoint.endsWith("/1"))?.lastOkAt).not.toBeNull();
    expect(JSON.parse(seen[0]!)).toEqual({ title: "t", body: "b", url: "/" });
  });

  test("a row whose keys can't be used is pruned instead of failing on every push", async () => {
    const s = store();
    s.upsert({ endpoint: "https://fcm.googleapis.com/fcm/send/bad", keys: { p256dh: "p", auth: "a" } });
    let fetched = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => (fetched++, new Response(null, { status: 201 }))) as unknown as typeof fetch;
    try {
      const sender = createPushSender(s, createWebPushTransport(PY_VAPID));
      expect(await sender.send({ title: "t", body: "b", url: "/" })).toEqual({ sent: 0, pruned: 1, failed: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
    expect(s.list()).toEqual([]);

    s.upsert(sub(1));
    const fake = createPushSender(s, async () => {
      throw new UnusableSubscriptionError("bad keys");
    });
    expect(await fake.send({ title: "t", body: "b", url: "/" })).toEqual({ sent: 0, pruned: 1, failed: 0 });
    expect(s.list()).toEqual([]);
  });

  test("an oversized payload is sent with its body cut to fit, never refused", async () => {
    const s = store();
    s.upsert(sub(1));
    const seen: string[] = [];
    const sender = createPushSender(s, async (_t, data) => (seen.push(data), 201));
    expect(await sender.send({ title: "t", body: "x".repeat(4000), url: "/" })).toEqual({ sent: 1, pruned: 0, failed: 0 });
    expect(new TextEncoder().encode(seen[0]!).byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(seen[0]!).body.endsWith("…")).toBe(true);
  });

  test("sendPush is a no-op without an active sender", async () => {
    setActivePushSender(undefined);
    expect(await sendPush({ title: "t", body: "b", url: "/" })).toEqual({ sent: 0, pruned: 0, failed: 0 });
  });
});

const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

describe("createWebPushTransport", () => {
  test("encrypts with aes128gcm, signs with a Python-format VAPID pair, and never follows redirects", async () => {
    const ec = { name: "ECDH", namedCurve: "P-256" } as const;
    const client = await crypto.subtle.generateKey(ec, true, ["deriveBits"]);
    const vapid = PY_VAPID;
    const captured: { url?: string; init?: RequestInit } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    try {
      const status = await createWebPushTransport(vapid)(
        {
          endpoint: "https://push.example/abc",
          p256dh: b64url(await crypto.subtle.exportKey("raw", client.publicKey)),
          auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
          createdAt: 0,
          lastOkAt: null,
        },
        JSON.stringify({ title: "t", body: "b", url: "/" }),
      );
      expect(status).toBe(201);
      expect(captured.init!.redirect).toBe("manual");
      const headers = captured.init!.headers as Record<string, string>;
      expect(headers["content-encoding"]).toBe("aes128gcm");
      expect(headers["authorization"]).toStartWith("vapid t=");
      expect((captured.init!.body as Uint8Array).byteLength).toBe(4096);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("createWebPushTransport redirects", () => {
  test("a 3xx from the push service is returned as-is and its target is never hit", async () => {
    const hits: string[] = [];
    const inner = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => (hits.push(r.method), new Response(null, { status: 201 })) });
    const outer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${inner.port}/internal` } }),
    });
    // The library insists on https, so downgrade at the fetch boundary and keep the real fetch's redirect handling.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(url.replace(/^https:/, "http:"), init)) as typeof fetch;
    try {
      const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const status = await createWebPushTransport(PY_VAPID)(
        {
          endpoint: `https://127.0.0.1:${outer.port}/push`,
          p256dh: b64url(await crypto.subtle.exportKey("raw", client.publicKey)),
          auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
          createdAt: 0,
          lastOkAt: null,
        },
        "{}",
      );
      expect(status).toBe(307);
      expect(hits).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      await inner.stop(true);
      await outer.stop(true);
    }
  });
});

describe("fitPayload", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

  test("a payload that fits is serialized unchanged, with the widened fields", () => {
    const p = { title: "t", body: "b", url: "/", tag: "chat", silent: true, requireInteraction: false, renotify: false };
    expect(JSON.parse(fitPayload(p))).toEqual(p);
  });

  test.each([
    ["4-byte emoji", "😀"],
    ["3-byte CJK", "漢"],
    ["JSON-escaped quote", '"'],
    ["JSON-escaped newline", "\n"],
    ["six-byte control escape", "\u0001"],
  ])("cuts a %s body on a code point and stays within the cap", (_name, unit) => {
    const out = fitPayload({ title: "Approval needed", body: unit.repeat(5000), url: "/inbox?ask=a", tag: "ask:a" });
    expect(bytes(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const body: string = JSON.parse(out).body;
    expect(body.endsWith("…")).toBe(true);
    expect(Array.from(body.slice(0, -1)).every((c) => c === unit)).toBe(true);
    // The cut is as long as fits: one more escaped unit (at most 6 bytes) would cross the cap.
    expect(bytes(out)).toBeGreaterThan(MAX_PAYLOAD_BYTES - 6);
  });

  test("oversized title and tag are capped too", () => {
    const out = fitPayload({ title: "t".repeat(5000), body: "b", url: "/", tag: "x".repeat(5000) });
    expect(bytes(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(out).body).toBe("b");
  });
});
