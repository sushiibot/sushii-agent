import type { App, SocketModeReceiver } from "@slack/bolt";
import type { getLogger } from "../../logger.ts";

type Logger = ReturnType<typeof getLogger>;

// Defense-in-depth over @slack/socket-mode's own reconnect: if the socket flaps (disconnects
// repeatedly in a short window) we stop it and reconnect with exponential backoff, so a
// pathological loop can never hammer apps.connections.open the way the Bun/undici ping bug did.
// Normal single blips fall below the flap threshold and are left to the library's own reconnect.

export interface FlapPolicy {
  /** Sliding window over which disconnects are counted. */
  windowMs: number;
  /** Disconnects within the window that trip the breaker. */
  maxFlaps: number;
  /** First backoff delay; doubles per consecutive trip. */
  baseMs: number;
  /** Upper bound on the backoff delay. */
  capMs: number;
  /** Uninterrupted connected time after which the trip escalation resets. */
  stableResetMs: number;
}

export const DEFAULT_FLAP_POLICY: FlapPolicy = {
  windowMs: 60_000,
  maxFlaps: 5,
  baseMs: 1_000,
  capMs: 300_000,
  stableResetMs: 120_000,
};

/** Exponential backoff with ±20% jitter, capped. `tripCount` is the number of prior trips. */
export function computeBackoffMs(tripCount: number, policy: FlapPolicy, rand: () => number = Math.random): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** tripCount);
  const jitter = exp * 0.2 * (rand() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/** Sliding-window disconnect counter. `record` returns true when the window is saturated (trip). */
export class FlapTracker {
  private readonly times: number[] = [];
  constructor(private readonly windowMs: number, private readonly maxFlaps: number) {}
  record(now: number): boolean {
    this.times.push(now);
    while (this.times.length && now - this.times[0]! > this.windowMs) this.times.shift();
    return this.times.length >= this.maxFlaps;
  }
  clear(): void {
    this.times.length = 0;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Watches the app's Socket Mode client for flapping and applies exponential-backoff restarts.
 *  No-op on a healthy socket. Safe to call once after `app.start()`. */
export function superviseSlackApp(
  app: App,
  receiver: SocketModeReceiver,
  deps: { logger: Logger; policy?: FlapPolicy; now?: () => number },
): void {
  const policy = deps.policy ?? DEFAULT_FLAP_POLICY;
  const now = deps.now ?? Date.now;
  const client = receiver.client;
  const tracker = new FlapTracker(policy.windowMs, policy.maxFlaps);
  let tripCount = 0;
  let tripping = false;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  client.on("connected", () => {
    if (stableTimer) clearTimeout(stableTimer);
    // Reset the escalation only after the socket has stayed up uninterrupted.
    stableTimer = setTimeout(() => {
      if (!tripping) {
        tripCount = 0;
        tracker.clear();
      }
    }, policy.stableResetMs);
  });

  client.on("disconnected", () => {
    if (stableTimer) clearTimeout(stableTimer);
    if (tripping) return; // our own stop/start emits disconnects — ignore while handling a trip
    if (!tracker.record(now())) return; // below threshold — let the library reconnect normally
    tripping = true;
    void (async () => {
      const delayMs = computeBackoffMs(tripCount, policy);
      deps.logger.error({ tripCount, delayMs }, "slack socket flapping — backing off before reconnect");
      try {
        await app.stop();
      } catch (err) {
        deps.logger.warn({ err }, "slack supervisor: app.stop() during backoff failed");
      }
      await sleep(delayMs);
      tripCount += 1;
      try {
        await app.start();
      } catch (err) {
        deps.logger.error({ err }, "slack supervisor: reconnect after backoff failed");
      }
      tracker.clear();
      tripping = false;
    })();
  });
}
