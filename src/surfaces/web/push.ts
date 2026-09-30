import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { buildPushPayload, type PushSubscription as WebPushSubscription } from "@block65/webcrypto-web-push";
import { webPushSubscriptions } from "../../db/schema.ts";
import type { WebPushConfig } from "../../config.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("web-push");

const base64url = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+=*$/);

export const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((u) => u.startsWith("https://"), "endpoint must be https"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: base64url, auth: base64url }),
});
export type SubscriptionInput = z.infer<typeof subscriptionSchema>;

export const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  url: z.string().min(1),
  tag: z.string().optional(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/** The encrypted aes128gcm record is padded to 4096 octets, which leaves this much plaintext. */
export const MAX_PAYLOAD_BYTES = 3993;

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

export class PushSubscriptionStore {
  constructor(private readonly db: Database) {}

  upsert(sub: SubscriptionInput, now = Date.now()): void {
    ormFor(this.db)
      .insert(webPushSubscriptions)
      .values({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, createdAt: now })
      .onConflictDoUpdate({
        target: webPushSubscriptions.endpoint,
        set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      })
      .run();
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
    const res = await fetch(sub.endpoint, { ...req, signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.status;
  };
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
      const data = JSON.stringify(pushPayloadSchema.parse(payload));
      if (new TextEncoder().encode(data).byteLength > MAX_PAYLOAD_BYTES) {
        throw new Error(`push payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      }
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
