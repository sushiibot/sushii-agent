## Why

sushii-agent already runs in a private AI-research server as a bot, but there's no way for a whitelisted set of external harnesses/agents to read that server's channels or post into them programmatically, attributed to the person whose agent posted it. This should be possible without spinning up a separate service or bot.

## What Changes

- Add an MCP server, hosted in the existing sushii-agent process, exposing three tools: `fetch` (recent/ranged channel messages), `search` (full-text search over channel history, always excluding deleted and automod-flagged content — that's moderation-internal and must never reach an external harness), and `send` (post a text message to a channel).
- Add Discord OAuth2 (`identify` scope) as the MCP server's authorization mechanism — friends log in with their own Discord account; the resulting identity is used both to gate access (per-guild whitelist check) and to attribute sent messages (webhook `username`/`avatar_url`).
- Add a small HTTP surface (`Bun.serve`) alongside the existing Discord gateway connection: `/mcp` (Streamable HTTP transport), `/oauth/authorize`, `/oauth/callback`.
- Add a new config block keyed by guild id, each entry holding just a user whitelist (no channel-level restriction — any channel in an allowed guild is fair game). A Discord user id can appear in more than one guild's whitelist; the OAuth callback resolves the full set of guilds a user is allowed into and rejects entirely if that set is empty. Only one guild (the private research server) is populated in v1, but the shape supports more without a schema change.
- Add per-channel webhook lookup/creation with an in-memory cache, used to post messages under the caller's Discord identity instead of the bot's. Text-only in v1 — no attachment/image uploads.
- Expose the new HTTP port through existing sushii infra (reverse proxy + TLS on the apps host) so friends can reach it from their own machines.

## Capabilities

### New Capabilities
- `discord-mcp-bridge`: MCP server (OAuth-gated, per-guild whitelist-restricted) exposing read (fetch/search) and send (webhook post) tools, scoped to whichever guild(s) the authenticated caller is whitelisted for.

### Modified Capabilities
(none — no existing spec-level behavior changes; this is purely additive)

## Impact

- **New code** (sushii-agent): MCP server setup (`src/mcp/server/` or similar), OAuth callback + Discord token exchange, per-guild whitelist lookup, webhook cache/lookup, MCP tool wrappers around `fetchChannelMessages` and `searchMessages` (with deleted/automod content forced off), plus the new send-via-webhook tool.
- **Existing code reused, not modified**: `src/tools/fetchChannelMessages.ts` and `src/tools/searchMessages.ts` are called directly by the new MCP tool wrappers. `searchGuildMessages.ts` is not used by this change.
- **Config**: new block in `guild-config.json` (or a new config file), keyed by guild id — each entry holds just its per-guild user whitelist. No channel-level restriction.
- **Dependencies**: `@modelcontextprotocol/sdk` already present (client-side only today); this adds its server-side surface. No new HTTP framework — `Bun.serve` covers the small route set.
- **Infra** (sushii-ansible): requires exposing a new port through the existing apps-host reverse proxy/TLS setup, and registering the OAuth redirect URI in the Discord application dashboard. No new deploy pipeline — same container, same `./deploy.sh` target.
