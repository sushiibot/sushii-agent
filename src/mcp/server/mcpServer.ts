import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "discord.js";
import type { McpSession } from "./session.ts";
import type { WebhookCache } from "./webhooks.ts";
import { mcpFetch, mcpSearch, mcpSend, FETCH_INPUT, SEARCH_INPUT, SEND_INPUT } from "./tools.ts";

export { SEND_INPUT } from "./tools.ts";

/** Reads the caller's session, stashed on AuthInfo.extra by the bearer-auth check in http.ts. */
function sessionFromExtra(extra: { authInfo?: { extra?: Record<string, unknown> } }): McpSession {
  const session = extra.authInfo?.extra?.["session"] as McpSession | undefined;
  if (!session) throw new Error("Tool call missing authenticated session");
  return session;
}

export function buildMcpServer(client: Client<true>, webhookCache: WebhookCache): McpServer {
  const server = new McpServer({ name: "sushii-agent-bridge", version: "1.0.0" });

  server.registerTool(
    "fetch",
    {
      description: "Fetch recent or ranged messages from a Discord channel.",
      inputSchema: FETCH_INPUT.shape,
    },
    async (args, extra) => mcpFetch(client, sessionFromExtra(extra), args),
  );

  server.registerTool(
    "search",
    {
      description: "Full-text search over cached channel history in a guild.",
      inputSchema: SEARCH_INPUT.shape,
    },
    async (args, extra) => mcpSearch(sessionFromExtra(extra), args),
  );

  server.registerTool(
    "send",
    {
      description: "Post a text message to a Discord channel, attributed to your own Discord identity.",
      inputSchema: SEND_INPUT.shape,
    },
    async (args, extra) => mcpSend(client, webhookCache, sessionFromExtra(extra), args),
  );

  return server;
}
