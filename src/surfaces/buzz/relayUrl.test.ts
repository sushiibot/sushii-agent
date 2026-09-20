import { describe, expect, test } from "bun:test";
import { normalizeRelayUrl, parseRelayUrls, parseWikiMap, parseAvatarMap } from "./relayUrl.ts";

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

describe("parseAvatarMap", () => {
  test("normalizes relay-url keys so they match the per-relay loop key", () => {
    expect(parseAvatarMap('{"wss://Buzz.Example/": "https://buzz.example/media/a.png"}')).toEqual({
      "https://buzz.example": "https://buzz.example/media/a.png",
    });
  });

  test("empty or undefined yields an empty map (falls back to BUZZ_AVATAR_URL)", () => {
    expect(parseAvatarMap("")).toEqual({});
    expect(parseAvatarMap(undefined)).toEqual({});
  });

  test("drops entries with a blank or non-string url", () => {
    expect(parseAvatarMap('{"https://a": "", "https://b": 5, "https://c": "https://c/x.png"}')).toEqual({ "https://c": "https://c/x.png" });
  });

  test("throws on invalid JSON or a non-object payload", () => {
    expect(() => parseAvatarMap("not json")).toThrow();
    expect(() => parseAvatarMap('["https://a"]')).toThrow();
  });
});
