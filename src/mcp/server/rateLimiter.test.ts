import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rateLimiter.ts";

describe("RateLimiter", () => {
  test("allows requests up to the limit, then blocks", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
  });

  test("tracks separate keys independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("b")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(false);
  });

  test("resets once the window has passed", () => {
    const limiter = new RateLimiter(1, -1); // already-expired window
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true); // window already expired, so this starts a fresh one
  });
});
