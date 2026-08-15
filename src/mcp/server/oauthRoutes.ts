import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Client } from "discord.js";
import { z } from "zod";
import { config, getPermittedGuildIds } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { buildAuthorizeUrl, resolveIdentityFromCode } from "./discordOAuth.ts";
import type { SessionStore } from "./session.ts";
import {
  type AuthorizationCodeStore,
  type ClientStore,
  type PendingAuthorizationStore,
  type PendingConsentStore,
  isAllowedRedirectUri,
  isValidPkceValue,
  verifyPkce,
} from "./oauthServer.ts";
import { buildOAuthResponseRedirect, errorPage, escapeHtml, oauthConfig, publicOrigin } from "./httpUtil.ts";
import { RateLimiter, rateLimit } from "./rateLimiter.ts";

const logger = getLogger("mcp-bridge");

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_OPAQUE_PARAM_LENGTH = 2048;

const RegisterBodySchema = z.object({
  redirect_uris: z.array(z.string().max(MAX_URI_LENGTH)).min(1).max(MAX_REDIRECT_URIS),
});

const TokenBodySchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().max(MAX_OPAQUE_PARAM_LENGTH),
  redirect_uri: z.string().max(MAX_URI_LENGTH),
  client_id: z.string().max(MAX_OPAQUE_PARAM_LENGTH),
  code_verifier: z.string().refine(isValidPkceValue, "code_verifier must be 43-128 chars, unreserved charset"),
});

export interface OAuthDeps {
  client: Client<true>;
  sessionStore: SessionStore;
  clientStore: ClientStore;
  pendingAuthStore: PendingAuthorizationStore;
  pendingConsentStore: PendingConsentStore;
  codeStore: AuthorizationCodeStore;
}

/**
 * Registers the full hand-rolled OAuth 2.0 Authorization Server surface: RFC 8414 metadata,
 * RFC 7591 dynamic client registration, PKCE-protected authorize/consent/callback, and the
 * authorization_code token endpoint. Discord OAuth (via discordOAuth.ts) is used only as this
 * server's own identity check — see resolveIdentityFromCode's doc comment.
 */
export function registerOAuthRoutes(app: Hono, deps: OAuthDeps): void {
  const { client, sessionStore, clientStore, pendingAuthStore, pendingConsentStore, codeStore } = deps;

  const registerLimiter = new RateLimiter(20, 60_000);
  const authorizeLimiter = new RateLimiter(60, 60_000);
  const tokenLimiter = new RateLimiter(60, 60_000);

  const authServerMetadataHandler = (c: Context) => {
    // Registration/authorize/token would 500/no-op anyway when unconfigured, but metadata is a
    // GET with no state check — without this it would reflect an attacker-controlled Host header
    // into issuer/endpoint URLs for any client that discovers us before we're configured.
    if (!oauthConfig()) return c.json({ error: "not_configured" }, 503);
    const origin = publicOrigin(c.req.url);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  };
  // RFC 8414 metadata, plus the OIDC-discovery alias some clients probe instead.
  app.get("/.well-known/oauth-authorization-server", authServerMetadataHandler);
  app.get("/.well-known/openid-configuration", authServerMetadataHandler);

  // RFC 7591 Dynamic Client Registration. Clients are public (native/CLI apps using PKCE), so
  // no client_secret is issued. Intentionally unauthenticated, as DCR requires — the security
  // boundary is the consent step in /oauth/callback below, not who can register. Rate-limited
  // and size-capped because unauthenticated writes into a bounded store are a lockout/memory-DoS
  // vector otherwise (a flood can evict every real registration once the store fills).
  app.post(
    "/oauth/register",
    rateLimit(registerLimiter),
    bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "invalid_client_metadata" }, 413) }),
    async (c) => {
      if (!c.req.header("content-type")?.includes("application/json")) {
        return c.json({ error: "invalid_client_metadata", error_description: "Content-Type must be application/json" }, 415);
      }
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
      }
      const parsed = RegisterBodySchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" }, 400);
      }
      const { redirect_uris: redirectUris } = parsed.data;
      if (!redirectUris.every(isAllowedRedirectUri)) {
        return c.json(
          { error: "invalid_redirect_uri", error_description: "redirect_uris must be https, or http restricted to loopback" },
          400,
        );
      }

      const registered = clientStore.register(redirectUris);
      logger.info({ clientId: registered.clientId }, "MCP bridge client registered");
      return c.json(
        {
          client_id: registered.clientId,
          redirect_uris: registered.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          client_id_issued_at: Math.floor(Date.now() / 1000),
        },
        201,
      );
    },
  );

  app.get("/oauth/authorize", rateLimit(authorizeLimiter), (c) => {
    const clientId = c.req.query("client_id");
    const redirectUri = c.req.query("redirect_uri");
    const responseType = c.req.query("response_type");
    const clientState = c.req.query("state");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");

    logger.debug({ clientId, redirectUri, responseType, codeChallengeMethod }, "MCP bridge authorize request");

    // These failures can't safely redirect back to the caller's redirect_uri — we haven't
    // verified it belongs to the client yet, so doing so would be an open redirect.
    if (!clientId || !redirectUri || responseType !== "code") {
      return c.html(errorPage("Invalid request", "Missing or invalid client_id, redirect_uri, or response_type."), 400);
    }
    const registered = clientStore.get(clientId);
    if (!registered || !registered.redirectUris.includes(redirectUri)) {
      return c.html(errorPage("Invalid request", "Unknown client_id or unregistered redirect_uri."), 400);
    }
    if (!codeChallenge || codeChallengeMethod !== "S256" || !isValidPkceValue(codeChallenge)) {
      return c.html(errorPage("Invalid request", "PKCE with S256 is required."), 400);
    }
    if (clientState !== undefined && clientState.length > MAX_OPAQUE_PARAM_LENGTH) {
      return c.html(errorPage("Invalid request", "state is too long."), 400);
    }

    const oauth = oauthConfig();
    if (!oauth) return c.html(errorPage("Not configured", "MCP bridge OAuth is not configured."), 500);

    const nonce = pendingAuthStore.issue({ clientId, redirectUri, clientState, codeChallenge });
    const url = buildAuthorizeUrl(oauth.clientId, oauth.redirectUri, nonce);
    return c.redirect(url);
  });

  app.get("/oauth/callback", async (c) => {
    const nonce = c.req.query("state");
    const pending = nonce ? pendingAuthStore.consume(nonce) : null;
    if (!pending) {
      return c.html(errorPage("Login failed", "Invalid or expired login attempt. Please try again."), 400);
    }

    const discordCode = c.req.query("code");
    if (!discordCode) {
      const redirect = buildOAuthResponseRedirect(pending.redirectUri, {
        error: c.req.query("error") ?? "access_denied",
        error_description: c.req.query("error_description"),
        state: pending.clientState,
      });
      if (!redirect) return c.html(errorPage("Login failed", "Invalid client redirect target."), 400);
      return c.redirect(redirect);
    }

    const oauth = oauthConfig();
    if (!oauth) {
      const redirect = buildOAuthResponseRedirect(pending.redirectUri, { error: "server_error", state: pending.clientState });
      return redirect ? c.redirect(redirect) : c.html(errorPage("Not configured", "MCP bridge OAuth is not configured."), 500);
    }

    let identity;
    try {
      identity = await resolveIdentityFromCode(oauth.clientId, oauth.clientSecret, oauth.redirectUri, discordCode);
    } catch (err) {
      logger.error({ err }, "Discord OAuth code exchange failed");
      const redirect = buildOAuthResponseRedirect(pending.redirectUri, { error: "server_error", state: pending.clientState });
      return redirect ? c.redirect(redirect) : c.html(errorPage("Login failed", "Could not verify your Discord identity."), 502);
    }

    const permittedGuildIds = getPermittedGuildIds(config.guildConfig, identity.id);
    if (permittedGuildIds.length === 0) {
      logger.warn({ discordUserId: identity.id }, "MCP bridge login rejected: not whitelisted in any guild");
      // Rendered here rather than redirected to the client's redirect_uri: this is our own
      // authorization decision, not something Discord told the client, so passing it through
      // would let a caller silently probe "is Discord user X whitelisted on this bridge?" by
      // watching for a redirect vs. no redirect on their own server, without X ever noticing.
      return c.html(errorPage("Access denied", "Your Discord account isn't whitelisted for the MCP bridge."), 403);
    }

    // A consent step, not an immediate code issuance: Discord's login screen only vouches for
    // identity, not for which client is asking or where the resulting access goes. Without this,
    // an attacker who dynamically registers their own client_id/redirect_uri could get a
    // whitelisted user to unknowingly authorize them just by clicking a crafted authorize link.
    const consentToken = pendingConsentStore.issue({
      identity,
      permittedGuildIds,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      clientState: pending.clientState,
      codeChallenge: pending.codeChallenge,
    });

    const guildNames = permittedGuildIds.map((id) => client.guilds.cache.get(id)?.name ?? id);

    c.header("Cache-Control", "no-store");
    return c.html(
      `<!doctype html><html><head><title>Authorize MCP client</title></head><body>` +
        `<p>Logged in as ${escapeHtml(identity.username)}.</p>` +
        `<p>An application will be linked to your Discord identity to use this bridge's tools in these servers:</p>` +
        `<ul>${guildNames.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>` +
        `<p>Only approve this if you just initiated a login from a tool you trust. The application will be ` +
        `redirected to:</p>` +
        `<p><strong>${escapeHtml(new URL(pending.redirectUri).origin)}</strong></p>` +
        `<p style="color:#666">(full callback URL: <code>${escapeHtml(pending.redirectUri)}</code>, ` +
        `client id: <code>${escapeHtml(pending.clientId)}</code>)</p>` +
        `<form method="POST" action="/oauth/consent">` +
        `<input type="hidden" name="consent_token" value="${escapeHtml(consentToken)}">` +
        `<button type="submit" name="action" value="approve">Approve</button> ` +
        `<button type="submit" name="action" value="deny">Deny</button>` +
        `</form></body></html>`,
    );
  });

  app.post(
    "/oauth/consent",
    bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.html(errorPage("Invalid request", "Request too large."), 413) }),
    async (c) => {
      let body: Record<string, string | File>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.html(errorPage("Invalid request", "Malformed form submission."), 400);
      }
      const consentToken = body["consent_token"];
      const action = body["action"];
      if (typeof consentToken !== "string") {
        return c.html(errorPage("Invalid request", "Missing consent_token."), 400);
      }

      const consent = pendingConsentStore.consume(consentToken);
      if (!consent) {
        return c.html(errorPage("Login failed", "Invalid or expired consent attempt. Please try again."), 400);
      }

      if (action !== "approve") {
        logger.info({ discordUserId: consent.identity.id, clientId: consent.clientId }, "MCP bridge consent denied");
        const redirect = buildOAuthResponseRedirect(consent.redirectUri, {
          error: "access_denied",
          state: consent.clientState,
        });
        return redirect ? c.redirect(redirect) : c.html(errorPage("Login failed", "Invalid client redirect target."), 400);
      }

      const code = codeStore.issue({
        identity: consent.identity,
        permittedGuildIds: consent.permittedGuildIds,
        clientId: consent.clientId,
        redirectUri: consent.redirectUri,
        codeChallenge: consent.codeChallenge,
      });
      logger.info(
        { discordUserId: consent.identity.id, clientId: consent.clientId, guildCount: consent.permittedGuildIds.length },
        "MCP bridge authorization code issued",
      );
      const redirect = buildOAuthResponseRedirect(consent.redirectUri, { code, state: consent.clientState });
      return redirect ? c.redirect(redirect) : c.html(errorPage("Login failed", "Invalid client redirect target."), 400);
    },
  );

  app.post(
    "/oauth/token",
    rateLimit(tokenLimiter),
    bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: "invalid_request" }, 413) }),
    async (c) => {
      let body: Record<string, string | File>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json({ error: "invalid_request" }, 400);
      }
      const parsed = TokenBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = parsed.data;

      const authCode = codeStore.consume(code);
      if (!authCode || authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      if (!(await verifyPkce(codeVerifier, authCode.codeChallenge))) {
        return c.json({ error: "invalid_grant" }, 400);
      }

      const token = sessionStore.mint({ identity: authCode.identity, permittedGuildIds: authCode.permittedGuildIds });
      c.header("Cache-Control", "no-store");
      return c.json({
        access_token: token,
        token_type: "bearer",
        expires_in: sessionStore.ttlSeconds,
      });
    },
  );
}
