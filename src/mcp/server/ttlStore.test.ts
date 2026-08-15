import { describe, expect, test } from "bun:test";
import { randomId, TtlMap } from "./ttlStore.ts";

describe("TtlMap", () => {
  test("peek returns a value without removing it", () => {
    const map = new TtlMap<string>(60_000);
    map.set("k", "v");
    expect(map.peek("k")).toBe("v");
    expect(map.peek("k")).toBe("v");
  });

  test("take returns a value and removes it", () => {
    const map = new TtlMap<string>(60_000);
    map.set("k", "v");
    expect(map.take("k")).toBe("v");
    expect(map.take("k")).toBeNull();
  });

  test("expired entries are evicted from both peek and take", () => {
    const map = new TtlMap<string>(-1);
    map.set("k", "v");
    expect(map.peek("k")).toBeNull();
    expect(map.take("k")).toBeNull();
  });

  test("evicts the oldest entry once maxEntries is reached", () => {
    const map = new TtlMap<string>(60_000, 2);
    map.set("a", "1");
    map.set("b", "2");
    map.set("c", "3");
    expect(map.peek("a")).toBeNull();
    expect(map.peek("b")).toBe("2");
    expect(map.peek("c")).toBe("3");
  });
});

describe("randomId", () => {
  test("produces distinct ids", () => {
    expect(randomId(16)).not.toBe(randomId(16));
  });

  test("applies the given prefix", () => {
    expect(randomId(16, "code")).toMatch(/^code_/);
  });
});
