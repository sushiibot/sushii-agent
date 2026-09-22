import { describe, expect, test } from "bun:test";
import { computeBackoffMs, FlapTracker, DEFAULT_FLAP_POLICY, type FlapPolicy } from "./supervisor.ts";

const policy: FlapPolicy = { windowMs: 60_000, maxFlaps: 5, baseMs: 1_000, capMs: 300_000, stableResetMs: 120_000 };

describe("computeBackoffMs", () => {
  test("doubles per trip and is capped", () => {
    const noJitter = () => 0.5; // rand*2-1 = 0 → no jitter
    expect(computeBackoffMs(0, policy, noJitter)).toBe(1_000);
    expect(computeBackoffMs(1, policy, noJitter)).toBe(2_000);
    expect(computeBackoffMs(2, policy, noJitter)).toBe(4_000);
    expect(computeBackoffMs(10, policy, noJitter)).toBe(policy.capMs); // 1000*2^10 > cap
  });

  test("jitter stays within ±20% and never negative", () => {
    for (const r of [0, 1, 0.5, 0.9]) {
      const v = computeBackoffMs(1, policy, () => r);
      expect(v).toBeGreaterThanOrEqual(1_600); // 2000 - 20%
      expect(v).toBeLessThanOrEqual(2_400); // 2000 + 20%
    }
  });
});

describe("FlapTracker", () => {
  test("trips once maxFlaps disconnects land within the window", () => {
    const t = new FlapTracker(policy.windowMs, policy.maxFlaps);
    let now = 1_000;
    for (let i = 0; i < policy.maxFlaps - 1; i++) expect(t.record(now)).toBe(false);
    expect(t.record(now)).toBe(true); // the 5th within-window disconnect trips
  });

  test("disconnects spaced beyond the window never trip", () => {
    const t = new FlapTracker(policy.windowMs, policy.maxFlaps);
    let now = 0;
    for (let i = 0; i < 10; i++) {
      expect(t.record(now)).toBe(false);
      now += policy.windowMs + 1; // each one ages the previous out of the window
    }
  });

  test("clear resets the window", () => {
    const t = new FlapTracker(policy.windowMs, policy.maxFlaps);
    for (let i = 0; i < policy.maxFlaps - 1; i++) t.record(1_000);
    t.clear();
    expect(t.record(1_000)).toBe(false);
  });
});

test("DEFAULT_FLAP_POLICY is exported and sane", () => {
  expect(DEFAULT_FLAP_POLICY.maxFlaps).toBeGreaterThan(1);
  expect(DEFAULT_FLAP_POLICY.capMs).toBeGreaterThanOrEqual(DEFAULT_FLAP_POLICY.baseMs);
});
