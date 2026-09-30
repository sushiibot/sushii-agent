import { Hono } from "hono";
import type { Client } from "discord.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config, getPermittedGuildIds } from "../../config.ts";
import { getDb } from "../../db/index.ts";
import { publicOrigin } from "./httpUtil.ts";
import { type OAuthDeps, registerOAuthRoutes } from "./oauthRoutes.ts";
import { AuthorizationCodeStore, ClientStore, PendingAuthorizationStore, PendingConsentStore } from "./oauthServer.ts";
import { SessionStore } from "./session.ts";
import { WebhookCache } from "./webhooks.ts";
import { buildMcpServer } from "./mcpServer.ts";

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

export function buildMcpHttpApp(
  client: Client<true>,
  sessionStore: SessionStore = new SessionStore(undefined, getDb()),
  extraStores: Partial<Omit<OAuthDeps, "sessionStore" | "client">> = {},
): Hono {
  const app = new Hono();
  const webhookCache = new WebhookCache();

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  registerOAuthRoutes(app, {
    client,
    sessionStore,
    clientStore: extraStores.clientStore ?? new ClientStore(undefined, getDb()),
    pendingAuthStore: extraStores.pendingAuthStore ?? new PendingAuthorizationStore(),
    pendingConsentStore: extraStores.pendingConsentStore ?? new PendingConsentStore(),
    codeStore: extraStores.codeStore ?? new AuthorizationCodeStore(),
  });

  app.get(RESOURCE_METADATA_PATH, (c) => {
    const origin = publicOrigin(c.req.url);
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
      c.header("WWW-Authenticate", `Bearer resource_metadata="${publicOrigin(c.req.url)}${RESOURCE_METADATA_PATH}"`);
      return c.json({ error: "unauthorized" }, 401);
    }

    // Re-derived from the live guild config on every request rather than trusting what was
    // baked in at login: a whitelist edit should take effect immediately in both directions —
    // newly-granted access without waiting out the token's TTL, and revoked access without
    // an already-issued token continuing to work until it expires.
    const permittedGuildIds = getPermittedGuildIds(config.guildConfig, session.identity.id);
    if (permittedGuildIds.length === 0) {
      return c.json({ error: "unauthorized", error_description: "No longer whitelisted for the MCP bridge" }, 401);
    }

    const authInfo: AuthInfo = {
      token,
      clientId: session.identity.id,
      scopes: ["identify"],
      extra: { session: { ...session, permittedGuildIds } },
    };

    const mcpServer = buildMcpServer(client, webhookCache);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    return transport.handleRequest(c.req.raw, { authInfo });
  });

  return app;
}
