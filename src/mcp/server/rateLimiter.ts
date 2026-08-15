import type { Context, Next } from "hono";

/**
 * Fixed-window per-key request counter. Backs rate limiting on the unauthenticated-by-design
 * OAuth endpoints (registration, authorize, token) — without it, a flood of trivial requests
 * can evict every legitimate entry from the TtlMap-backed stores those routes write to.
 */
export class RateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request should be allowed, false if the key is over its limit. */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.counts.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count++;
    return true;
  }

  private sweep(now: number): void {
    if (this.counts.size < 5_000) return;
    for (const [key, entry] of this.counts) {
      if (entry.resetAt <= now) this.counts.delete(key);
    }
  }
}

function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "direct";
}

/** Hono middleware: 429s requests from a single client IP once it exceeds the limiter's window. */
export function rateLimit(limiter: RateLimiter) {
  return async (c: Context, next: Next) => {
    if (!limiter.check(clientIp(c))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  };
}
