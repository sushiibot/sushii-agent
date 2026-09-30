import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { buildPushPayload, type PushSubscription as WebPushSubscription } from "@block65/webcrypto-web-push";
import { webPushSubscriptions } from "../../db/schema.ts";
import type { WebPushConfig } from "../../config.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("web-push");

/** Browser push services (Chrome/FCM, Firefox, Safari, Edge). Any other host would let a subscription aim our POSTs anywhere. */
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const u = new URL(endpoint);
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Decodes base64url, tolerating the padding some encoders add; undefined if it is not base64url. */
export function decodeBase64url(value: string): Uint8Array | undefined {
  const bare = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(bare)) return undefined;
  return new Uint8Array(Buffer.from(bare, "base64url"));
}

const isUncompressedP256 = (b: Uint8Array | undefined) => b?.length === 65 && b[0] === 0x04;

const keyString = z.string().min(1).max(256);

export const subscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(isAllowedPushEndpoint, "endpoint must be an https URL on a known push service"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: keyString.refine((k) => isUncompressedP256(decodeBase64url(k)), "p256dh must be a 65-byte uncompressed P-256 point"),
    auth: keyString.refine((k) => decodeBase64url(k)?.length === 16, "auth must be 16 bytes"),
  }),
});
export type SubscriptionInput = z.infer<typeof subscriptionSchema>;

export const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  url: z.string().min(1),
  tag: z.string().optional(),
  silent: z.boolean().optional(),
  requireInteraction: z.boolean().optional(),
  renotify: z.boolean().optional(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/** The encrypted aes128gcm record is padded to 4096 octets, which leaves this much plaintext. */
export const MAX_PAYLOAD_BYTES = 3993;

const FIELD_CAP = 256;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;

function cutPoints(text: string, n: number): string {
  const points = Array.from(text);
  return points.length <= n ? text : `${points.slice(0, Math.max(0, n - 1)).join("")}…`;
}

/** Serializes `payload` within MAX_PAYLOAD_BYTES, cutting the body (by code point) rather than failing.
 *  JSON escaping can grow a character to six bytes, so the fit is measured on the encoded string. */
export function fitPayload(payload: PushPayload): string {
  const parsed = pushPayloadSchema.parse(payload);
  const fits = (p: PushPayload) => utf8Bytes(JSON.stringify(p)) <= MAX_PAYLOAD_BYTES;
  if (fits(parsed)) return JSON.stringify(parsed);
  // Title, url and tag are ours and short; capping them only matters for a pathological caller.
  const base: PushPayload = {
    ...parsed,
    title: cutPoints(parsed.title, FIELD_CAP),
    url: parsed.url.length > FIELD_CAP * 8 ? "/" : parsed.url,
    ...(parsed.tag !== undefined ? { tag: cutPoints(parsed.tag, FIELD_CAP) } : {}),
    body: "",
  };
  const points = Array.from(parsed.body).length;
  let lo = 0;
  let hi = points;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits({ ...base, body: cutPoints(parsed.body, mid) })) lo = mid;
    else hi = mid - 1;
  }
  return JSON.stringify({ ...base, body: cutPoints(parsed.body, lo) });
}

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
  lastOkAt: number | null;
}

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { webPushSubscriptions } });
}

/** One owner has a handful of devices; stale rows from reinstalled browsers are what fills this up. */
export const MAX_SUBSCRIPTIONS = 20;

export class PushSubscriptionStore {
  constructor(
    private readonly db: Database,
    private readonly maxSubscriptions = MAX_SUBSCRIPTIONS,
  ) {}

  /** Upserts by endpoint. A new endpoint at the cap evicts the least recently delivered-to subscription
   *  rather than being refused, so a new device is never locked out by dead ones. */
  upsert(sub: SubscriptionInput, now = Date.now()): void {
    const orm = ormFor(this.db);
    orm.transaction((tx) => {
      const exists = tx.select({ e: webPushSubscriptions.endpoint }).from(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, sub.endpoint)).get();
      if (!exists) {
        const count = tx.select({ n: sql<number>`count(*)` }).from(webPushSubscriptions).get()?.n ?? 0;
        const excess = count - this.maxSubscriptions + 1;
        if (excess > 0) {
          const stale = tx
            .select({ endpoint: webPushSubscriptions.endpoint })
            .from(webPushSubscriptions)
            .orderBy(sql`coalesce(${webPushSubscriptions.lastOkAt}, ${webPushSubscriptions.createdAt})`)
            .limit(excess)
            .all();
          for (const row of stale) tx.delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, row.endpoint)).run();
          logger.info({ evicted: stale.length }, "push subscription cap reached; evicted the least recently used");
        }
      }
      tx.insert(webPushSubscriptions)
        .values({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, createdAt: now })
        .onConflictDoUpdate({
          target: webPushSubscriptions.endpoint,
          set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        })
        .run();
    });
  }

  remove(endpoint: string): void {
    ormFor(this.db).delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, endpoint)).run();
  }

  list(): StoredSubscription[] {
    return ormFor(this.db).select().from(webPushSubscriptions).all();
  }

  markOk(endpoint: string, now = Date.now()): void {
    ormFor(this.db).update(webPushSubscriptions).set({ lastOkAt: now }).where(eq(webPushSubscriptions.endpoint, endpoint)).run();
  }
}

/** Delivers one encrypted message and returns the push service's HTTP status. */
export type PushTransport = (sub: StoredSubscription, data: string) => Promise<number>;

export function createWebPushTransport(vapid: WebPushConfig, timeoutMs = 10_000): PushTransport {
  return async (sub, data) => {
    const target: WebPushSubscription = { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    const req = await buildPushPayload({ data, options: { ttl: 24 * 60 * 60, urgency: "normal" } }, target, vapid);
    // A redirect from a push service is never legitimate, and following one would re-send the POST elsewhere.
    const res = await fetch(sub.endpoint, { ...req, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.status;
  };
}

/** Checks the VAPID pair the push library will import on every send. Returns why it is unusable, or undefined. */
export async function checkVapidKeys(vapid: WebPushConfig): Promise<string | undefined> {
  if (/=/.test(vapid.publicKey) || /=/.test(vapid.privateKey)) return "VAPID keys must be base64url without padding";
  const pub = decodeBase64url(vapid.publicKey);
  if (!isUncompressedP256(pub)) return "VAPID_PUBLIC_KEY must decode to a 65-byte uncompressed P-256 point (leading 0x04)";
  const d = decodeBase64url(vapid.privateKey);
  if (d?.length !== 32) return "VAPID_PRIVATE_KEY must decode to exactly 32 bytes";
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  try {
    await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64(pub!.slice(1, 33)), y: b64(pub!.slice(33, 65)), d: vapid.privateKey },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    return `VAPID key pair failed to import: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

export interface PushResult {
  sent: number;
  pruned: number;
  failed: number;
}

export interface PushSender {
  send(payload: PushPayload): Promise<PushResult>;
}

export function createPushSender(store: PushSubscriptionStore, transport: PushTransport): PushSender {
  return {
    async send(payload) {
      const data = fitPayload(payload);
      const subs = store.list();
      const results = await Promise.allSettled(subs.map((s) => transport(s, data)));
      const out: PushResult = { sent: 0, pruned: 0, failed: 0 };
      results.forEach((r, i) => {
        const sub = subs[i]!;
        const host = URL.canParse(sub.endpoint) ? new URL(sub.endpoint).host : "invalid";
        if (r.status === "rejected") {
          out.failed++;
          logger.warn({ err: r.reason, host }, "push delivery failed");
        } else if (r.value >= 200 && r.value < 300) {
          out.sent++;
          store.markOk(sub.endpoint);
        } else if (r.value === 404 || r.value === 410) {
          out.pruned++;
          store.remove(sub.endpoint);
          logger.info({ host, status: r.value }, "pruned expired push subscription");
        } else if (r.value === 401 || r.value === 403) {
          out.failed++;
          logger.error({ host, status: r.value }, "push service rejected the VAPID signature; the client must resubscribe if the key changed");
        } else {
          out.failed++;
          logger.warn({ host, status: r.value }, "push service rejected delivery");
        }
      });
      return out;
    },
  };
}

let activeSender: PushSender | undefined;

export function setActivePushSender(sender: PushSender | undefined): void {
  activeSender = sender;
}

/** Notifies every subscribed device. A no-op when the web gateway or VAPID keys are not configured. */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  if (!activeSender) return { sent: 0, pruned: 0, failed: 0 };
  return activeSender.send(payload);
}
