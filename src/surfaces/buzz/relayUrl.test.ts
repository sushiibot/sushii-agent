import { describe, expect, test } from "bun:test";
import { normalizeRelayUrl, parseRelayUrls, parseWikiMap } from "./relayUrl.ts";

describe("normalizeRelayUrl", () => {
  test("maps ws/wss to http/https, strips trailing slash, lowercases", () => {
    expect(normalizeRelayUrl("wss://Buzz.Example/")).toBe("https://buzz.example");
    expect(normalizeRelayUrl("ws://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeRelayUrl("  https://x.test//  ")).toBe("https://x.test");
  });
});

describe("parseRelayUrls", () => {
  test("splits, trims, drops empties", () => {
    expect(parseRelayUrls("wss://a, wss://b ,")).toEqual(["https://a", "https://b"]);
  });

  test("dedupes scheme/casing/slash variants of the same relay (no double poll loops)", () => {
    expect(parseRelayUrls("wss://a,https://a/,wss://A")).toEqual(["https://a"]);
  });

  test("empty or undefined yields an empty list", () => {
    expect(parseRelayUrls("")).toEqual([]);
    expect(parseRelayUrls(undefined)).toEqual([]);
  });
});

describe("parseWikiMap", () => {
  test("normalizes relay-url keys so they match the per-relay loop key", () => {
    expect(parseWikiMap('{"wss://Buzz.Example/": "guild123"}')).toEqual({ "https://buzz.example": "guild123" });
  });

  test("empty or undefined yields an empty map (no community gets wiki access)", () => {
    expect(parseWikiMap("")).toEqual({});
    expect(parseWikiMap(undefined)).toEqual({});
  });

  test("drops entries with a blank or non-string guild id", () => {
    expect(parseWikiMap('{"https://a": "", "https://b": 5, "https://c": "g"}')).toEqual({ "https://c": "g" });
  });

  test("throws on invalid JSON or a non-object payload", () => {
    expect(() => parseWikiMap("not json")).toThrow();
    expect(() => parseWikiMap('["https://a"]')).toThrow();
  });
});
