import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { config } from "../../config.ts";
import { buildMcpHttpApp } from "./http.ts";
import { AuthorizationCodeStore, ClientStore, PendingAuthorizationStore, PendingConsentStore, verifyPkce } from "./oauthServer.ts";
import { SessionStore } from "./session.ts";

// oauthConfig() reads these fresh on every call, so setting them here (rather than via env vars,
// which config.ts only reads once at import time) makes OAuth "configured" for this whole file.
config.discordOAuthClientId = "test-discord-client-id";
config.discordOAuthClientSecret = "test-discord-client-secret";
config.discordOAuthRedirectUri = "https://bridge.example.com/oauth/callback";

// A valid RFC 7636 code_verifier: 43-128 chars from the unreserved URL charset.
const VALID_CODE_VERIFIER = "a-random-code-verifier-that-is-long-enough-to-pass-pkce-format-checks";

function fakeClient(): Client<true> {
  return { user: { id: "bot1" }, guilds: { cache: new Map() } } as unknown as Client<true>;
}

function makeApp(sessionStore = new SessionStore()) {
  const clientStore = new ClientStore();
  const pendingAuthStore = new PendingAuthorizationStore();
  const pendingConsentStore = new PendingConsentStore();
  const codeStore = new AuthorizationCodeStore();
  const app = buildMcpHttpApp(fakeClient(), sessionStore, { clientStore, pendingAuthStore, pendingConsentStore, codeStore });
  return { app, sessionStore, clientStore, pendingAuthStore, pendingConsentStore, codeStore };
}

async function registerClient(app: ReturnType<typeof buildMcpHttpApp>, redirectUri = "http://localhost:1234/callback") {
  const res = await app.request("https://bridge.example.com/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

describe("/mcp bearer auth", () => {
  // permittedGuildIds is now re-derived from live config on every request (not trusted from
  // what was baked into the session at mint time), so tests that expect a minted session to
  // still be authorized need a matching live whitelist entry.
  let originalGuildConfig: typeof config.guildConfig;
  beforeEach(() => {
    originalGuildConfig = config.guildConfig;
    config.guildConfig = {
      ...originalGuildConfig,
      guildA: { allowedRoles: [], mcpBridgeAllowedUserIds: ["u1"] },
      guildB: { allowedRoles: [], mcpBridgeAllowedUserIds: ["u2"] },
    };
  });
  afterEach(() => {
    config.guildConfig = originalGuildConfig;
  });

  test("rejects a request with no Authorization header", async () => {
    const { app } = makeApp();
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  test("rejects an unknown bearer token", async () => {
    const { app } = makeApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("does not 401 a valid, unexpired session token", async () => {
    const sessionStore = new SessionStore();
    const token = sessionStore.mint({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
    });
    const { app } = makeApp(sessionStore);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).not.toBe(401);
  });

  test("a request from one session doesn't get torn down by another session's DELETE (per-request transport)", async () => {
    const sessionStore = new SessionStore();
    const tokenA = sessionStore.mint({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
    });
    const tokenB = sessionStore.mint({
      identity: { id: "u2", username: "bob", avatar: null },
      permittedGuildIds: ["guildB"],
    });
    const { app } = makeApp(sessionStore);

    // A previous shared-transport implementation would have this DELETE tear down
    // every caller's connection (stateless mode has no session id to scope it by).
    await app.request("/mcp", { method: "DELETE", headers: { Authorization: `Bearer ${tokenA}` } });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  test("rejects a token whose identity is no longer whitelisted in any guild, even though it was at mint time", async () => {
    const sessionStore = new SessionStore();
    const token = sessionStore.mint({
      identity: { id: "revoked-user", username: "eve", avatar: null },
      permittedGuildIds: ["guildA"], // stale — not backed by any live config.guildConfig entry
    });
    const { app } = makeApp(sessionStore);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("picks up a guild grant added after the token was minted, without needing a new token", async () => {
    const sessionStore = new SessionStore();
    // Not one of the beforeEach-whitelisted identities — starts with no live access at all.
    const token = sessionStore.mint({ identity: { id: "not-yet-granted", username: "alice", avatar: null }, permittedGuildIds: [] });
    const { app } = makeApp(sessionStore);

    const beforeGrant = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(beforeGrant.status).toBe(401);

    config.guildConfig = { ...config.guildConfig, guildC: { allowedRoles: [], mcpBridgeAllowedUserIds: ["not-yet-granted"] } };

    const afterGrant = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(afterGrant.status).not.toBe(401);
  });
});

describe("RFC 9728 protected-resource metadata", () => {
  test("exposes authorization_servers and resource", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://bridge.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://bridge.example.com"]);
  });
});

describe("RFC 8414 authorization server metadata", () => {
  test("exposes endpoints at both well-known paths", async () => {
    const { app } = makeApp();
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const res = await app.request(`https://bridge.example.com${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe("https://bridge.example.com");
      expect(body.authorization_endpoint).toBe("https://bridge.example.com/oauth/authorize");
      expect(body.token_endpoint).toBe("https://bridge.example.com/oauth/token");
      expect(body.registration_endpoint).toBe("https://bridge.example.com/oauth/register");
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    }
  });
});

describe("unknown routes", () => {
  test("returns a JSON 404 instead of a plain-text body", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("RFC 7591 dynamic client registration", () => {
  test("registers a client and returns a client_id with no secret", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:1234/callback"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string };
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toEqual(["http://localhost:1234/callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  test("rejects registration with no redirect_uris", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a redirect_uri that isn't https or loopback http", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/callback"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  test("rejects a redirect_uri that isn't a valid URL", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["not a url"] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects more than 10 redirect_uris", async () => {
    const { app } = makeApp();
    const redirectUris = Array.from({ length: 11 }, (_, i) => `https://example${i}.com/callback`);
    const res = await app.request("https://bridge.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a non-JSON Content-Type", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ redirect_uris: ["https://example.com/callback"] }),
    });
    expect(res.status).toBe(415);
  });
});

describe("/oauth/authorize", () => {
  test("rejects an unregistered client_id without redirecting", async () => {
    const { app } = makeApp();
    const url =
      "https://bridge.example.com/oauth/authorize?client_id=bogus&redirect_uri=http://localhost:1234/callback&response_type=code&code_challenge=abc&code_challenge_method=S256";
    const res = await app.request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rejects a redirect_uri not registered for the client", async () => {
    const { app } = makeApp();
    const clientId = await registerClient(app);
    const url = `https://bridge.example.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://evil.example.com/callback&response_type=code&code_challenge=abc&code_challenge_method=S256`;
    const res = await app.request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rejects a missing code_challenge_method", async () => {
    const { app } = makeApp();
    const clientId = await registerClient(app);
    const url = `https://bridge.example.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:1234/callback&response_type=code`;
    const res = await app.request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rejects a non-S256 code_challenge_method", async () => {
    const { app } = makeApp();
    const clientId = await registerClient(app);
    const url = `https://bridge.example.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:1234/callback&response_type=code&code_challenge=abc&code_challenge_method=plain`;
    const res = await app.request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rejects a code_challenge that isn't the right RFC 7636 shape", async () => {
    const { app } = makeApp();
    const clientId = await registerClient(app);
    const url = `https://bridge.example.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:1234/callback&response_type=code&code_challenge=too-short&code_challenge_method=S256`;
    const res = await app.request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rejects a state longer than the max opaque param length", async () => {
    const { app } = makeApp();
    const clientId = await registerClient(app);
    const url = `https://bridge.example.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:1234/callback&response_type=code&code_challenge=${VALID_CODE_VERIFIER}&code_challenge_method=S256&state=${"a".repeat(2049)}`;
    const res = await app.request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rate-limits repeated requests from the same client", async () => {
    const { app } = makeApp();
    const clientId = await registerClient(app);
    const url = `https://bridge.example.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:1234/callback&response_type=code&code_challenge=${VALID_CODE_VERIFIER}&code_challenge_method=S256`;
    let sawRateLimited = false;
    for (let i = 0; i < 65; i++) {
      const res = await app.request(url, { redirect: "manual" });
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});

describe("/oauth/callback", () => {
  test("rejects an unknown or expired state without a client redirect_uri to fall back to", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/callback?code=abc&state=not-a-real-nonce");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("redirects to the client with an error when Discord itself reports an error", async () => {
    const { app, pendingAuthStore } = makeApp();
    const nonce = pendingAuthStore.issue({
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge: "abc",
    });
    const res = await app.request(
      `https://bridge.example.com/oauth/callback?state=${nonce}&error=access_denied&error_description=user+cancelled`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("http://localhost:1234/callback");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  function mockDiscordFetch(discordUserId: string) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "discord-access-token", token_type: "Bearer" }), { status: 200 });
      }
      if (url.includes("/users/@me")) {
        return new Response(JSON.stringify({ id: discordUserId, username: "eve", avatar: null }), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  test("renders a generic error for a non-whitelisted user instead of redirecting to the client (closes the whitelist oracle)", async () => {
    const { app, pendingAuthStore } = makeApp();
    const nonce = pendingAuthStore.issue({
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge: VALID_CODE_VERIFIER,
    });
    const restoreFetch = mockDiscordFetch("definitely-not-a-whitelisted-user-id");
    try {
      const res = await app.request(`https://bridge.example.com/oauth/callback?code=discord-code&state=${nonce}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/html");
    } finally {
      restoreFetch();
    }
  });

  test("shows a consent page for a whitelisted user instead of issuing a code immediately", async () => {
    const { app, pendingAuthStore } = makeApp();
    const whitelistedUserId = "test-whitelisted-user";
    const originalGuildConfig = config.guildConfig;
    config.guildConfig = { ...originalGuildConfig, "test-guild": { allowedRoles: [], mcpBridgeAllowedUserIds: [whitelistedUserId] } };

    const nonce = pendingAuthStore.issue({
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge: VALID_CODE_VERIFIER,
    });
    const restoreFetch = mockDiscordFetch(whitelistedUserId);
    try {
      const res = await app.request(`https://bridge.example.com/oauth/callback?code=discord-code&state=${nonce}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Approve");
      expect(body).toContain("consent_token");
    } finally {
      restoreFetch();
      config.guildConfig = originalGuildConfig;
    }
  });
});

describe("/oauth/consent", () => {
  test("rejects a missing or expired consent_token", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_token: "not-real", action: "approve" }),
    });
    expect(res.status).toBe(400);
  });

  test("denying redirects to the client with error=access_denied and issues no code", async () => {
    const { app, pendingConsentStore, codeStore } = makeApp();
    const consentToken = pendingConsentStore.issue({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge: "abc",
    });
    const res = await app.request("https://bridge.example.com/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_token: consentToken, action: "deny" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    // consumed even on denial, and no code was ever minted for it
    expect(pendingConsentStore.consume(consentToken)).toBeNull();
    expect(codeStore.consume("anything")).toBeNull();
  });

  test("approving redirects to the client with a code that exchanges for a working session token", async () => {
    const { app, sessionStore, pendingConsentStore } = makeApp();
    const codeVerifier = VALID_CODE_VERIFIER;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const codeChallenge = Buffer.from(digest).toString("base64url");

    const consentToken = pendingConsentStore.issue({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      clientState: "xyz",
      codeChallenge,
    });

    const consentRes = await app.request("https://bridge.example.com/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_token: consentToken, action: "approve" }),
      redirect: "manual",
    });
    expect(consentRes.status).toBe(302);
    const location = new URL(consentRes.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("http://localhost:1234/callback");
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://localhost:1234/callback",
        client_id: "c1",
        code_verifier: codeVerifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(tokenBody.token_type).toBe("bearer");
    expect(tokenBody.expires_in).toBe(sessionStore.ttlSeconds);
    expect(sessionStore.verify(tokenBody.access_token)).toEqual({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
    });
  });
});

describe("/oauth/token", () => {
  test("rejects a request with an unknown authorization code", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-real-code",
        redirect_uri: "http://localhost:1234/callback",
        client_id: "some-client",
        code_verifier: VALID_CODE_VERIFIER,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects a malformed request missing required fields", async () => {
    const { app } = makeApp();
    const res = await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("rejects a code minted for a different client_id", async () => {
    const { app, codeStore } = makeApp();
    const code = codeStore.issue({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      codeChallenge: "abc",
    });
    const res = await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:1234/callback",
        client_id: "someone-elses-client",
        code_verifier: VALID_CODE_VERIFIER,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects a mismatched PKCE verifier", async () => {
    const { app, codeStore } = makeApp();
    const code = codeStore.issue({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      codeChallenge: "abc",
    });
    const res = await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:1234/callback",
        client_id: "c1",
        code_verifier: "wrong-verifier-that-is-also-long-enough-to-pass-the-pkce-format-check",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(await verifyPkce("wrong-verifier-that-is-also-long-enough-to-pass-the-pkce-format-check", "abc")).toBe(false);
  });

  test("rejects a code that's already been redeemed once", async () => {
    const { app, codeStore } = makeApp();
    const code = codeStore.issue({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
      clientId: "c1",
      redirectUri: "http://localhost:1234/callback",
      codeChallenge: "abc",
    });
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:1234/callback",
      client_id: "c1",
      code_verifier: VALID_CODE_VERIFIER,
    });
    // First redemption fails PKCE (challenge doesn't match), but still consumes the code.
    await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const secondRes = await app.request("https://bridge.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    expect(secondRes.status).toBe(400);
    const body = (await secondRes.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });
});
