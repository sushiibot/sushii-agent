import { Hono } from "hono";
import type { Client } from "discord.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config, getPermittedGuildIds } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { buildAuthorizeUrl, resolveIdentityFromCode } from "./discordOAuth.ts";
import { SessionStore, StateStore } from "./session.ts";
import { WebhookCache } from "./webhooks.ts";
import { buildMcpServer } from "./mcpServer.ts";

const logger = getLogger("mcp-bridge");

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

/** Returns the Discord OAuth app credentials, or null if any are unconfigured. */
function oauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const { discordOAuthClientId, discordOAuthClientSecret, discordOAuthRedirectUri } = config;
  if (!discordOAuthClientId || !discordOAuthClientSecret || !discordOAuthRedirectUri) return null;
  return { clientId: discordOAuthClientId, clientSecret: discordOAuthClientSecret, redirectUri: discordOAuthRedirectUri };
}

export function buildMcpHttpApp(client: Client<true>, sessionStore: SessionStore = new SessionStore()): Hono {
  const app = new Hono();
  const stateStore = new StateStore();
  const webhookCache = new WebhookCache();

  app.get("/oauth/authorize", (c) => {
    const oauth = oauthConfig();
    if (!oauth) return c.text("MCP bridge OAuth is not configured", 500);
    const state = stateStore.issue();
    const url = buildAuthorizeUrl(oauth.clientId, oauth.redirectUri, state);
    return c.redirect(url);
  });

  app.get("/oauth/callback", async (c) => {
    const oauth = oauthConfig();
    if (!oauth) return c.text("MCP bridge OAuth is not configured", 500);

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state || !stateStore.consume(state)) {
      return c.html(htmlPage("Login failed", "<p>Invalid or expired login attempt. Please try again.</p>"), 400);
    }

    let identity;
    try {
      identity = await resolveIdentityFromCode(oauth.clientId, oauth.clientSecret, oauth.redirectUri, code);
    } catch (err) {
      logger.error({ err }, "Discord OAuth code exchange failed");
      return c.html(htmlPage("Login failed", "<p>Could not verify your Discord identity. Please try again.</p>"), 502);
    }

    const permittedGuildIds = getPermittedGuildIds(config.guildConfig, identity.id);
    if (permittedGuildIds.length === 0) {
      logger.warn({ discordUserId: identity.id }, "MCP bridge login rejected: not whitelisted in any guild");
      return c.html(htmlPage("Access denied", "<p>Your Discord account isn't whitelisted for the MCP bridge.</p>"), 403);
    }

    const token = sessionStore.mint({ identity, permittedGuildIds });
    logger.info({ discordUserId: identity.id, guildCount: permittedGuildIds.length }, "MCP bridge session issued");

    c.header("Cache-Control", "no-store");
    return c.html(
      htmlPage(
        "MCP bridge login",
        `<p>Logged in as ${escapeHtml(identity.username)}. Use this token as your MCP client's bearer token:</p><pre>${escapeHtml(token)}</pre><p>It expires in about an hour.</p>`,
      ),
    );
  });

  app.get(RESOURCE_METADATA_PATH, (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  });

  // A fresh McpServer + transport per request — the transport holds request-scoped stream
  // state keyed only by JSON-RPC request id, so sharing one instance across callers lets
  // concurrent users' responses cross-deliver, and a DELETE from any caller tears down
  // every other caller's connection (stateless mode has no session id to scope it by).
  app.all("/mcp", async (c) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const session = token ? sessionStore.verify(token) : null;
    if (!token || !session) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${new URL(c.req.url).origin}${RESOURCE_METADATA_PATH}"`);
      return c.json({ error: "unauthorized" }, 401);
    }

    const authInfo: AuthInfo = {
      token,
      clientId: session.identity.id,
      scopes: ["identify"],
      extra: { session },
    };

    const mcpServer = buildMcpServer(client, webhookCache);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    return transport.handleRequest(c.req.raw, { authInfo });
  });

  return app;
}
