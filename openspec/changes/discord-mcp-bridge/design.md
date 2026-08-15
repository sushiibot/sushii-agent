## Context

sushii-agent is a single Bun process (`src/index.ts`) that connects to Discord over the gateway (`src/bot.ts`) and stores per-guild config in `guild-config.json` (loaded once at startup via `src/config.ts`, keyed by guild id, typed as `GuildConfig`). It has no HTTP server today — the process only holds a Discord `Client` and a SQLite connection (`bun:sqlite`, via `src/db/index.ts`). It already depends on `@modelcontextprotocol/sdk`, but only as an MCP *client* (`src/mcp/SushiiMcpClient.ts`, calling an external MCP server for mod-history lookups) — the server-side SDK surface is unused.

This change adds a second entry point into the same process: an MCP server, reachable over HTTPS, that lets a whitelisted set of external callers (the maintainer plus a few friends, each running their own harness/agent) read and post into whichever Discord guild(s) they're whitelisted for. Auth is Discord OAuth2 itself, so a caller's Discord identity is both the login mechanism and the attribution used when posting.

## Goals / Non-Goals

**Goals:**
- Add `fetch`, `search`, and `send` MCP tools, reachable over a public HTTPS endpoint, gated by Discord OAuth + a per-guild static whitelist.
- Reuse the existing bot process, existing `fetchChannelMessages`/`searchMessages` logic, and existing `guild-config.json` config mechanism — no new service, no new deploy pipeline.
- Support a caller being whitelisted in more than one guild.
- Never expose deleted or automod-flagged message content, regardless of caller-supplied search parameters.
- Attribute sent messages to the caller's real Discord identity (name + avatar), never a caller-supplied string.

**Non-Goals:**
- Channel-level access control (any channel in an allowed guild is fair game once the guild check passes).
- Attachments/file/image uploads on `send` (text-only).
- A generic "any guild can self-enable this" onboarding flow — adding a guild is a manual `guild-config.json` edit + redeploy, same as every other config field there today.
- Guild-membership-based auth (`guilds` scope) — the whitelist is the sole gate.
- Persisted webhook tokens or an account-link table — both are avoidable given the design below.

## Decisions

### 1. OAuth: hand-rolled Discord authorization-code flow, our own opaque session token
The SDK's `ProxyOAuthServerProvider`/`mcpAuthRouter` were considered and rejected on inspection of the installed `@modelcontextprotocol/sdk` (1.12.x): that whole `server/auth/*` surface imports `express` directly (`OAuthServerProvider.authorize(...)` takes an Express `Response`, `mcpAuthRouter` returns an Express `RequestHandler`), which would add a full HTTP framework dependency for no benefit here. Worse, `ProxyOAuthServerProvider` is built to proxy the upstream IdP's token through to the client — the opposite of Decision 2 below, which the spec makes mandatory (server-issued token only, Discord's token used once and discarded).

Instead: `/oauth/authorize` and `/oauth/callback` are hand-written Hono routes. Discord's OAuth2 endpoints (`/oauth2/authorize`, `/oauth2/token`, `/users/@me`) are called directly via `fetch` — no OAuth client library. (`arctic`, a candidate purpose-built OAuth client with a built-in Discord provider, was evaluated and rejected: it's deprecated/unsupported on npm as of this change.) The RFC 9728 protected-resource metadata route is also hand-written, matching the shape `mcpAuthRouter` would have produced, without needing the router itself.

Also, `@modelcontextprotocol/sdk`'s Node-oriented `StreamableHTTPServerTransport` (built for `IncomingMessage`/`ServerResponse`) is not used either — `WebStandardStreamableHTTPServerTransport` (Web `Request`/`Response`, documented by the SDK as Hono/Bun-compatible) is used instead for `/mcp`, keeping the whole HTTP surface on Web-standard primitives Hono already speaks. Its `handleRequest(req, { authInfo })` accepts a pre-verified `AuthInfo` — our own bearer-token check (against the in-memory session map, see Decision 2) runs before this call and its result is passed straight through, which is also how the resolved session reaches tool handlers (`extra.authInfo.extra`, a `RequestHandlerExtra` field the SDK's high-level `McpServer.registerTool` callbacks receive natively).

### 2. The MCP server mints its own short-lived access token; Discord's token is only used once, at the callback
`ProxyOAuthServerProvider` proxies the *authorize*/*token* legs to Discord, but the MCP server still controls what it hands back to the client as the resulting access token — it is not obligated to pass Discord's own token through. Discord's OAuth access tokens default to a 7-day lifetime (`expires_in: 604800`), which is far too long a whitelist-revocation window to accept as-is. So: at the token exchange step, use the one-time Discord token only to call `GET /users/@me` and resolve the caller's identity, then discard it — mint sushii-agent's own opaque access token (short TTL, e.g. 1 hour) for the MCP session, with the caller's Discord identity and their whitelist-derived guild-set embedded (in an in-memory token→session map, since nothing here needs to survive a restart). `verifyAccessToken` looks up this local token, not Discord's.

Every tool call within that token's lifetime reads the guild-set off the already-resolved session; no per-call Discord API round-trip. A whitelist edit doesn't affect a token issued before the edit until that token expires and the client re-authenticates (bounded by the 1-hour TTL we control) — see Risks/Trade-offs and Migration Plan.

Alternative considered: re-check guild membership per tool call against a live Discord API. Rejected — whitelist membership is static config, not derived from server membership (explicitly a non-goal), so there's nothing to re-check that would change between calls.

### 3. Config: extend `GuildConfig` with an optional per-guild whitelist field
`src/config.ts`'s `GuildConfig` interface already holds several per-guild optional fields (e.g. `modRoleId?`, `alertsChannelId?`, `autoModDryRun?`) alongside the required `allowedRoles`, all loaded from `guild-config.json`. Add `mcpBridgeAllowedUserIds?: string[]` as another optional field — no new file, no new loader, no new table. A guild with no such field (or an empty array) simply isn't reachable through the bridge.

Alternative considered: a separate `mcp-bridge-config.json` file. Rejected — there's no reason to split config storage; the existing per-guild map is exactly the right shape, and it keeps one config file to redeploy instead of two.

### 4. Read tools wrap existing tool functions, `search` forces safety filters
`fetch` takes a required `channel_id`. The MCP wrapper first resolves the channel's actual guild via `client.channels.fetch(channel_id)` and rejects immediately if that channel's `guildId` isn't in the caller's verified guild set. Only then does it call `fetchChannelMessages` with that resolved `guildId` — which independently re-validates `channel.guildId === guildId` on its own fetch of the channel, giving two checks against a caller-supplied `channel_id` rather than one.

`search` calls `searchMessages` (`src/tools/searchMessages.ts`), whose only required parameter is `guildId` — `channel_id` is optional (guild-wide search is a normal, supported use). Because of this, the MCP `search` tool takes an explicit, **required** `guild_id` parameter (not derived from an optional `channel_id`), validated directly against the caller's verified guild set before the underlying call is made; `channel_id` remains an optional narrowing parameter, same as in `searchMessages` itself.

`searchMessages` natively supports `is_automod` as a caller-settable filter and returns `deleted_at` on every row, but its SQL WHERE clauses (both the FTS and non-FTS/browse paths) never filter on `deleted_at` at all. The MCP wrapper does not expose `is_automod` as a tool parameter, and always passes a fixed `is_automod: false`. For `deleted_at`, since there is no server-side filter to rely on, the MCP wrapper's post-query JS filter (drop any row with non-null `deleted_at`) is the **sole** enforcement point, not a backup — see the corresponding entry in Risks/Trade-offs. `searchGuildMessages.ts` (Discord's own live search API) is not used — `searchMessages`'s local FTS index covers the same need with the filtering above, and using one backend avoids two subtly different result shapes.

### 5. Send: fetch-or-create webhook, in-memory cache, no persisted webhook state
`send` takes a required `channel_id`. Same as `fetch`, the MCP wrapper resolves the channel's actual guild via `client.channels.fetch(channel_id)` first and rejects if that guild isn't in the caller's verified guild set — only then does it proceed to the webhook lookup below.

Look up the target channel's webhooks via `GET /channels/{id}/webhooks` (needs the bot to already have `Manage Webhooks` there — same permission surface it needs to create one), filter for one whose `application_id` matches the bot's own application id, and use it. If none exists, create one. Cache `{channelId → {id, token}}` in a plain in-process `Map` for the process lifetime. On a 404 from an execute call (webhook deleted out from under us), evict the cache entry and retry the fetch-or-create once.

Username/avatar for the webhook payload come from the caller's Discord identity as resolved during OAuth (`GET /users/@me` response cached on the session), never from a tool parameter — this is the control that makes impersonation-by-request impossible; a caller can only ever post as themselves.

Alternative considered: persist `{channelId → webhookId/token}` in SQLite so a process restart doesn't need to re-fetch. Rejected — `GET /channels/{id}/webhooks` is one cheap call per channel per process lifetime (not per message), and persisting a webhook token is one more secret at rest for no real benefit.

### 6. HTTP surface: Hono on `Bun.serve`, not Express
Three routes are needed: `/mcp` (Streamable HTTP MCP transport), `/oauth/authorize` (redirect to Discord), `/oauth/callback` (Discord's redirect target, token exchange), plus the RFC 9728 metadata route. Hono is used as the router (`Bun.serve({ fetch: app.fetch })`) — small, Web-standard-native, and a better fit than a raw `Bun.serve` path switch for a handful of routes with shared middleware (the bearer-auth check ahead of `/mcp`). Rejected Express specifically because pulling it in would only be to reuse the SDK's `server/auth/*` package, which Decision 1 already rejects for other reasons — no other route here needs a full framework. Started alongside `startBot()` in `src/index.ts`, sharing the same process and the same Discord `Client` instance the gateway connection already maintains.

### 7. Deployment: same container, new exposed port
No new service, no new `deploy.sh` target. The container needs one more port exposed and reverse-proxied (TLS + a subdomain) via the existing apps-host setup in `sushii-ansible`. The Discord application's OAuth redirect URI is registered once, pointing at that domain's `/oauth/callback`.

## Risks / Trade-offs

- **[Risk]** A bug in guild-set resolution at token-verification time could leak cross-guild access if a second guild is ever added to `mcpBridgeAllowedUserIds`. → Mitigation: every tool handler independently re-derives "is this channel's/guild's id in the caller's set" from the verified session, and re-validates against the target resource's actual guild (e.g. `fetchChannelMessages`'s own `channel.guildId === guildId` check) rather than trusting a caller-supplied guild id at face value.
- **[Risk]** `searchMessages`'s SQL never filters on `deleted_at` — the MCP `search` wrapper's post-query JS filter is the *only* place deleted-message content gets hidden from external callers, not a backup to server-side filtering. A refactor of the wrapper (or a bypass of it) reopens the leak with no second layer of defense. → Mitigation: keep the filter colocated with the tool handler itself (not a shared utility that could be silently skipped), and cover it with a test asserting a row with `deleted_at` set never appears in a `search` tool response.
- **[Risk]** Whitelist removal isn't instant — a token issued before the edit stays valid, and its guild-set, until it expires. → Mitigation: sushii-agent mints its own short-lived (≈1 hour) session token rather than passing Discord's 7-day token through (see Decision 2), so "remove someone" is bounded by that self-controlled TTL, not Discord's. If immediate revocation is ever needed, drop the in-memory token→session map entry (or restart the process) to invalidate outstanding sessions right away.
- **[Risk]** Webhook impersonation is only as safe as "username/avatar always come from the OAuth session." A future code change that accidentally threads a caller-supplied name through would silently reopen impersonation. → Mitigation: keep the `send` tool's input schema free of any `username`/`display_name`-shaped parameter, so there's no field to wire up by accident.
- **[Risk]** Exposing a new public HTTPS port on the apps host is a larger attack surface than "bot already in some Discord servers." → Mitigation: whitelist-only OAuth means an unauthenticated or non-whitelisted caller gets nothing beyond OAuth metadata; no tool call succeeds without a verified, whitelisted session.
- **[Trade-off]** No channel-level restriction means a whitelisted friend can read/post in *any* channel of an allowed guild, including ones unrelated to AI/harness research. Accepted per explicit instruction — simplicity over fine-grained scoping, and it's a small trusted-friend group.
- **[Trade-off]** In-memory webhook cache means the first `send` after every process restart pays one extra `GET /channels/{id}/webhooks` call. Negligible cost, avoids persisting a bearer-equivalent secret.

## Migration Plan

1. Ship the MCP server disabled by default (no guild has `mcpBridgeAllowedUserIds` populated) — purely additive, no existing behavior changes.
2. Deploy sushii-agent with the new port exposed but not yet reverse-proxied — smoke-test that `/mcp` responds (e.g. rejects unauthenticated calls as expected) locally/internally. The OAuth routes can't be meaningfully exercised yet since Discord's redirect requires a registered, reachable `redirect_uri`.
3. Wire up the reverse proxy + TLS + Discord OAuth redirect URI registration (sushii-ansible + Discord app dashboard), then verify the full OAuth round-trip end-to-end.
4. Populate `mcpBridgeAllowedUserIds` for the one private research guild with the maintainer's own Discord user id first, verify tool calls end-to-end, then add friends' ids.
5. Rollback: unset `mcpBridgeAllowedUserIds` for the guild (or revert the config file) and redeploy — no data migration to reverse since nothing is persisted beyond config. Note this only stops *new* token verifications; any already-issued token remains valid until its TTL expires (see Decision 2 / Risks).

## Open Questions

- Should there be any per-tool rate limiting (e.g. `send` spam from a misbehaving harness), or is "it's a few trusted friends" sufficient for v1?
- Does the maintainer want tool-call activity (who fetched/searched/sent what, when) logged anywhere beyond the existing `pino` request logs, given this is now an externally-reachable surface?
