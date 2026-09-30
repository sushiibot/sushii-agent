import { describe, expect, test } from "bun:test";
import { createPeerMatcher, parseIp } from "./peers.ts";

describe("peers", () => {
  test("matches exact IPs only", () => {
    const match = createPeerMatcher(["172.31.250.1"]);
    expect(match("172.31.250.1")).toBe(true);
    expect(match("::ffff:172.31.250.1")).toBe(true);
    expect(match("172.31.250.2")).toBe(false);
    expect(match("172.18.0.5")).toBe(false);
    expect(match("127.0.0.1")).toBe(false);
    expect(match(null)).toBe(false);
    expect(match(undefined)).toBe(false);
    expect(match("garbage")).toBe(false);
  });

  test("compares IPv6 by value, not spelling", () => {
    const match = createPeerMatcher(["::1"]);
    expect(match("0:0:0:0:0:0:0:1")).toBe(true);
    expect(match("::2")).toBe(false);
  });

  test("rejects ranges and malformed entries", () => {
    expect(() => createPeerMatcher(["172.31.250.0/24"])).toThrow();
    expect(() => createPeerMatcher(["nope"])).toThrow();
    expect(() => createPeerMatcher(["256.1.1.1"])).toThrow();
  });

  test("parses IPv6 forms", () => {
    expect(parseIp("::")).toEqual({ v: 6, n: 0n });
    expect(parseIp("1::")?.v).toBe(6);
    expect(parseIp("1:2:3:4:5:6:7:8")?.v).toBe(6);
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIp("1::2::3")).toBeNull();
    expect(parseIp("::ffff:10.0.0.1")).toEqual({ v: 4, n: 0x0a000001n });
  });
});
