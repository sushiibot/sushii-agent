## @modelcontextprotocol/sdk (TypeScript, server-side)

- `sushii-agent` currently only uses the SDK's *client* side (`src/mcp/SushiiMcpClient.ts`, `Client` + `StreamableHTTPClientTransport`) to call an external MCP server. It has never hosted a server itself — the server-side SDK surface (`@modelcontextprotocol/sdk/server`) is new usage here.
- The SDK ships `ProxyOAuthServerProvider`, built for exactly this shape: your MCP server proxies OAuth to an external authorization provider (here, Discord) rather than implementing its own auth server. You configure it with the external provider's authorization/token endpoints and supply `verifyAccessToken` / `getClient` hooks.
- `verifyAccessToken` is the natural place to enforce the whitelist: exchange/validate the token against Discord (or check a session store populated at the OAuth callback), resolve the caller's Discord user id, and reject if it's not on the whitelist.
- Typical deployment pattern: SDK's `mcpAuthRouter` middleware + `StreamableHTTPServerTransport` behind a plain HTTP router (Express or equivalent), publishing OAuth protected-resource metadata per RFC 9728, with bearer-token validation on every request.
- sushii-agent has no HTTP framework dependency yet (`src/index.ts` only starts the Discord gateway client + DB). Since Bun is the runtime, `Bun.serve` is sufficient for the small route set needed (`/mcp`, `/oauth/authorize` redirect, `/oauth/callback`) — no need to add Express as a new dependency.
  Source: https://github.com/modelcontextprotocol/typescript-sdk (README, OAuth section), https://deepwiki.com/modelcontextprotocol/typescript-sdk/5-oauth-authentication

## Discord OAuth2 (identify scope)

- Standard authorization-code flow: redirect to Discord's `/oauth2/authorize` with `client_id`, `redirect_uri`, `scope=identify`, `state`; Discord redirects back to the registered `redirect_uri` with a `code`; exchange it server-side (`client_id` + `client_secret` + `code`) for an access token; call `GET /users/@me` with that token to get the Discord user id, username, and avatar hash.
- The `identify` scope alone is sufficient — no `guilds`/`guilds.members.read` needed, since membership isn't part of the auth decision (whitelist is).
- `redirect_uri` must be registered exactly in the Discord application dashboard; this is the one piece of "infra" setup outside the codebase (registering the app's redirect URL once the domain is chosen).
  Source: https://docs.discord.com/developers/topics/oauth2
