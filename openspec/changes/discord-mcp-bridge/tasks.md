## 1. Config

- [x] 1.1 Add `mcpBridgeAllowedUserIds?: string[]` to the `GuildConfig` interface in `src/config.ts`
- [x] 1.2 Add a helper (e.g. `getPermittedGuildIds(discordUserId: string): string[]`) that scans `config.guildConfig` and returns every guild id whose `mcpBridgeAllowedUserIds` includes the given id

## 2. Discord OAuth flow

- [ ] 2.1 Register a Discord application OAuth redirect URI placeholder (final value set once domain is chosen in task 7.3) and add `DISCORD_OAUTH_CLIENT_ID`/`DISCORD_OAUTH_CLIENT_SECRET`/`DISCORD_OAUTH_REDIRECT_URI` to config/env — config/env plumbing done (`src/config.ts`); Discord dashboard registration still pending (needs the maintainer)
- [x] 2.2 Implement `/oauth/authorize` route: redirect to Discord's `/oauth2/authorize` with `client_id`, `redirect_uri`, `scope=identify`, `state`
- [x] 2.3 Implement `/oauth/callback` route: exchange `code` for a Discord access token, call `GET /users/@me`, discard the Discord token immediately after
- [x] 2.4 Resolve the caller's permitted-guild set (via 1.2) for the identified Discord user id; reject with an error page if the set is empty
- [x] 2.5 Mint a server-issued opaque session token (short TTL, ~1 hour) embedding the Discord identity (id, username, avatar) and permitted-guild set; store in an in-memory token→session map
- [x] 2.6 Return the server-issued token to the OAuth client per the MCP OAuth flow (not Discord's token)
- [x] 2.7 Add tests: a non-whitelisted Discord user id gets an empty permitted-guild set and is rejected at the callback; a user whitelisted in multiple guilds gets a session covering all of them

## 3. MCP server wiring

- [x] 3.1 Add `@modelcontextprotocol/sdk`'s server-side `McpServer` + `WebStandardStreamableHTTPServerTransport` setup (not `ProxyOAuthServerProvider`/`mcpAuthRouter` — see design.md Decision 1)
- [x] 3.2 Implement a bearer-token check (hand-written, not `verifyAccessToken`) to look up the presented token in the in-memory session map, checking TTL, and rejecting unknown/expired tokens
- [x] 3.3 Wire Hono on `Bun.serve` with routes for `/mcp`, `/oauth/authorize`, `/oauth/callback`, started alongside `startBot()` in `src/index.ts`
- [x] 3.4 Confirm `/mcp` rejects unauthenticated requests and exposes OAuth protected-resource metadata per RFC 9728
- [x] 3.5 Add tests: a token past its TTL is rejected by `verifyAccessToken`; Discord's own OAuth access token presented directly as an MCP bearer token is rejected (only server-issued tokens are valid)

## 4. Tool: fetch

- [x] 4.1 Implement the `fetch` MCP tool: required `channel_id` (+ existing `fetchChannelMessages` params)
- [x] 4.2 Resolve `channel_id`'s actual guild via `client.channels.fetch`; reject if that guild isn't in the caller's session guild-set
- [x] 4.3 Call `fetchChannelMessages` with the resolved `guildId` and return its result
- [x] 4.4 Add a test asserting `fetch` is rejected when `channel_id` resolves to a guild outside the caller's session guild-set, and succeeds for a channel inside it

## 5. Tool: search

- [x] 5.1 Implement the `search` MCP tool: required `guild_id`, optional `channel_id`/other `searchMessages` narrowing params — no `is_automod` parameter exposed
- [x] 5.2 Reject the call if `guild_id` isn't in the caller's session guild-set
- [x] 5.3 Call `searchMessages` with `is_automod: false` forced, then filter the result array to drop any row with non-null `deleted_at` before returning
- [x] 5.4 Add a test asserting a row with `deleted_at` set never appears in a `search` response, and one asserting `is_automod`-flagged rows never appear

## 6. Tool: send + webhook management

- [x] 6.1 Implement webhook fetch-or-create: `GET /channels/{id}/webhooks`, filter by the bot's own `application_id`, create via `Manage Webhooks` if none found
- [x] 6.2 Add an in-memory `Map<channelId, {id, token}>` cache, populated lazily per channel
- [x] 6.3 Implement the `send` MCP tool: required `channel_id` and message text only (no identity-shaped parameter in the schema)
- [x] 6.4 Resolve `channel_id`'s actual guild and reject if not in the caller's session guild-set (same pattern as 4.2)
- [x] 6.5 Execute the webhook with `username`/`avatar_url` set from the caller's session-resolved Discord identity
- [x] 6.6 On a 404 from the execute call, evict the cache entry, recreate the webhook, and retry the send once within the same call
- [x] 6.7 Add a test asserting `send` is rejected when `channel_id` resolves to a guild outside the caller's session guild-set
- [x] 6.8 Add a test asserting any extra name/avatar/identity-shaped field on a `send` call is ignored — the posted webhook `username`/`avatar_url` always match the caller's session identity
- [x] 6.9 Add a test/schema check confirming the `send` tool's input schema has no file/image/attachment field
- [x] 6.10 Add a test mocking a 404 on webhook execute and asserting the cache evicts, a replacement webhook is created, and the message is still delivered within the same call (single retry, not a caller-visible failure)

## 7. Infra and deployment

- [x] 7.1 Expose the new HTTP port in the sushii-agent container/compose config (`Dockerfile` `EXPOSE 8787`; sushii-ansible's compose template still needs the port/env wiring — separate repo, out of scope for this session)
- [ ] 7.2 Deploy with the port exposed but not yet proxied; smoke-test `/mcp` rejects unauthenticated calls as expected
- [ ] 7.3 Add reverse proxy + TLS + subdomain for the MCP endpoint in `sushii-ansible`
- [ ] 7.4 Register the final OAuth redirect URI in the Discord application dashboard, pointing at the live domain's `/oauth/callback`
- [ ] 7.5 Verify the full OAuth round-trip end-to-end against the live domain

## 8. Rollout

- [ ] 8.1 Populate `mcpBridgeAllowedUserIds` for the private research guild with the maintainer's own Discord user id only
- [ ] 8.2 Verify `fetch`, `search`, and `send` end-to-end against a real harness/MCP client
- [ ] 8.3 Add friends' Discord user ids to the whitelist one at a time, verifying each
