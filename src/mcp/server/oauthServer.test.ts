import { describe, expect, test } from "bun:test";
import {
  AuthorizationCodeStore,
  ClientStore,
  isAllowedRedirectUri,
  isValidPkceValue,
  PendingAuthorizationStore,
  PendingConsentStore,
  verifyPkce,
} from "./oauthServer.ts";

describe("isAllowedRedirectUri", () => {
  test("accepts https URLs", () => {
    expect(isAllowedRedirectUri("https://example.com/callback")).toBe(true);
  });

  test("accepts http restricted to loopback hosts", () => {
    expect(isAllowedRedirectUri("http://localhost:1234/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:1234/callback")).toBe(true);
  });

  test("accepts the full 127.0.0.0/8 loopback block, not just 127.0.0.1", () => {
    expect(isAllowedRedirectUri("http://127.0.0.2:1234/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.55.1.9:1234/callback")).toBe(true);
  });

  test("accepts IPv6 loopback", () => {
    expect(isAllowedRedirectUri("http://[::1]:1234/callback")).toBe(true);
  });

  test("rejects http to a non-loopback host", () => {
    expect(isAllowedRedirectUri("http://example.com/callback")).toBe(false);
  });

  test("rejects a redirect_uri with a fragment", () => {
    expect(isAllowedRedirectUri("https://example.com/callback#frag")).toBe(false);
  });

  test("rejects a malformed URL", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describe("isValidPkceValue", () => {
  test("accepts a 43-char value from the unreserved charset", () => {
    expect(isValidPkceValue("a".repeat(43))).toBe(true);
    expect(isValidPkceValue("A-Za-z0-9-._~".repeat(4).slice(0, 43))).toBe(true);
  });

  test("rejects values shorter than 43 or longer than 128 chars", () => {
    expect(isValidPkceValue("a".repeat(42))).toBe(false);
    expect(isValidPkceValue("a".repeat(129))).toBe(false);
  });

  test("rejects characters outside the unreserved charset", () => {
    expect(isValidPkceValue("a".repeat(42) + "!")).toBe(false);
  });
});

describe("ClientStore", () => {
  test("registers a client and returns it by id", () => {
    const store = new ClientStore();
    const registered = store.register(["http://localhost:1234/callback"]);
    expect(store.get(registered.clientId)).toEqual(registered);
  });

  test("returns null for an unknown client id", () => {
    const store = new ClientStore();
    expect(store.get("bogus")).toBeNull();
  });
});

describe("PendingAuthorizationStore", () => {
  test("round-trips an issued nonce exactly once", () => {
    const store = new PendingAuthorizationStore();
    const nonce = store.issue({
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge: "abc",
    });
    expect(store.consume(nonce)).toEqual({
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge: "abc",
    });
    expect(store.consume(nonce)).toBeNull();
  });

  test("returns null for an unknown nonce", () => {
    const store = new PendingAuthorizationStore();
    expect(store.consume("bogus")).toBeNull();
  });
});

describe("PendingConsentStore", () => {
  const consent = {
    identity: { id: "u1", username: "alice", avatar: null },
    permittedGuildIds: ["guildA"],
    clientId: "c1",
    redirectUri: "http://localhost:1234/callback",
    clientState: "xyz",
    codeChallenge: "abc",
  };

  test("round-trips an issued consent token exactly once", () => {
    const store = new PendingConsentStore();
    const token = store.issue(consent);
    expect(store.consume(token)).toEqual(consent);
    expect(store.consume(token)).toBeNull();
  });

  test("returns null for an unknown consent token", () => {
    const store = new PendingConsentStore();
    expect(store.consume("bogus")).toBeNull();
  });
});

describe("AuthorizationCodeStore", () => {
  const authCode = {
    identity: { id: "u1", username: "alice", avatar: null },
    permittedGuildIds: ["guildA"],
    clientId: "c1",
    redirectUri: "http://localhost:1234/callback",
    codeChallenge: "abc",
  };

  test("round-trips an issued code exactly once", () => {
    const store = new AuthorizationCodeStore();
    const code = store.issue(authCode);
    expect(store.consume(code)).toEqual(authCode);
    expect(store.consume(code)).toBeNull();
  });

  test("returns null for an unknown code", () => {
    const store = new AuthorizationCodeStore();
    expect(store.consume("bogus")).toBeNull();
  });
});

describe("verifyPkce", () => {
  test("accepts a matching S256 verifier/challenge pair", async () => {
    const verifier = "a-random-code-verifier-that-is-long-enough";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = Buffer.from(digest).toString("base64url");
    expect(await verifyPkce(verifier, challenge)).toBe(true);
  });

  test("rejects a mismatched verifier", async () => {
    expect(await verifyPkce("wrong-verifier", "some-challenge")).toBe(false);
  });
});
