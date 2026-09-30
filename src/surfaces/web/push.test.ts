import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { PushSubscriptionStore, createPushSender, createWebPushTransport, sendPush, setActivePushSender, type PushTransport } from "./push.ts";

function store(): PushSubscriptionStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new PushSubscriptionStore(db);
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

describe("createPushSender", () => {
  test("counts sends, prunes 404/410, keeps other failures", async () => {
    const s = store();
    for (const n of [1, 2, 3, 4, 5]) s.upsert(sub(n));
    const statuses: Record<string, number | Error> = {
      "https://push.example/1": 201,
      "https://push.example/2": 410,
      "https://push.example/3": 404,
      "https://push.example/4": 500,
      "https://push.example/5": new Error("timeout"),
    };
    const seen: string[] = [];
    const transport: PushTransport = async (target, data) => {
      seen.push(data);
      const r = statuses[target.endpoint]!;
      if (r instanceof Error) throw r;
      return r;
    };
    const result = await createPushSender(s, transport).send({ title: "t", body: "b", url: "/" });
    expect(result).toEqual({ sent: 1, pruned: 2, failed: 2 });
    expect(s.list().map((r) => r.endpoint).sort()).toEqual(["https://push.example/1", "https://push.example/4", "https://push.example/5"]);
    expect(s.list().find((r) => r.endpoint.endsWith("/1"))?.lastOkAt).not.toBeNull();
    expect(JSON.parse(seen[0]!)).toEqual({ title: "t", body: "b", url: "/" });
  });

  test("rejects payloads larger than the padded record allows", async () => {
    const sender = createPushSender(store(), async () => 201);
    await expect(sender.send({ title: "t", body: "x".repeat(4000), url: "/" })).rejects.toThrow("exceeds");
  });

  test("sendPush is a no-op without an active sender", async () => {
    setActivePushSender(undefined);
    expect(await sendPush({ title: "t", body: "b", url: "/" })).toEqual({ sent: 0, pruned: 0, failed: 0 });
  });
});

const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

describe("createWebPushTransport", () => {
  test("encrypts with aes128gcm and signs VAPID under Bun's WebCrypto", async () => {
    const ec = { name: "ECDH", namedCurve: "P-256" } as const;
    const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
    const client = await crypto.subtle.generateKey(ec, true, ["deriveBits"]);
    const vapid = {
      publicKey: b64url(await crypto.subtle.exportKey("raw", vapidPair.publicKey)),
      privateKey: vapidJwk.d!,
      subject: "mailto:test@example.com",
    };
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
      const headers = captured.init!.headers as Record<string, string>;
      expect(headers["content-encoding"]).toBe("aes128gcm");
      expect(headers["authorization"]).toStartWith("vapid t=");
      expect((captured.init!.body as Uint8Array).byteLength).toBe(4096);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
