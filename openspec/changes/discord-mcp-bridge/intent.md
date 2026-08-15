# Intent

**Goal:** Let a whitelisted set of users (the maintainer plus a few friends), each running their own harness/agent, read from and post into a private AI-research Discord server using their own Discord identity, without deploying a new service.

**Key decisions:**
- Reuse the existing sushii-agent bot process — new HTTP surface (MCP endpoint + Discord OAuth callback) runs alongside the existing gateway connection, no separate service/redeploy.
- Auth: MCP OAuth 2.1 flow with Discord as the identity provider (`identify` scope). No public signup — reject at the OAuth callback if the Discord user id isn't on a static whitelist. The OAuth access token itself carries the caller's identity for the rest of the session; no separate account-linking step or table.
- Exposure: public HTTPS via existing sushii infra (reverse-proxied domain + TLS on the apps host), since friends run harnesses from their own machines, not a shared private network.
- Read tools: two external-facing tools — `fetch` wraps `fetchChannelMessages` directly, `search` wraps the local FTS `searchMessages` for relevance/recency but always forces `deleted_at IS NULL` and `is_automod = false`, regardless of caller-supplied params — deleted and automod-flagged message content is moderation-internal and must never be exposed to external harnesses. (`searchGuildMessages`, which hits Discord's own search API, is not wrapped separately — `searchMessages` covers the same need locally with the filtering above.)
- Send tool: new capability — fetch-or-create a channel webhook (cached in-memory per `channel_id`, self-healing on 404, no persisted webhook table), execute it with `username`/`avatar_url` pulled from the caller's authenticated Discord identity (never a free-text/spoofable param). Text-only in v1 (no attachments).
- Scoping: no channel-level allowlist — `fetch` and `send` take an explicit `channel_id` (guild resolved from it); `search` takes an explicit, required `guild_id` since the underlying local FTS search supports guild-wide queries with no channel. Every tool call checks its resolved/given guild is in the caller's permitted-guild set. Any channel the bot itself can already see/post in within an allowed guild is fair game; the only gates are "which guild" and "which user."
- Config shape: a map keyed by guild id (today populated with one entry — the private research server), each entry holding just a user whitelist. Whitelist entries are per-guild, not global.
- A Discord user id can be whitelisted in more than one guild's entry (a friend could plausibly be in more than one research server). At the OAuth callback, resolve the *set* of guild ids this user id is whitelisted for across all configured guilds — not a single guild — and attach that set to the session/token. If the set is empty, reject at the callback (not whitelisted anywhere). Each tool call then checks the target guild is in that caller's set.
- Config lives in the same static, redeploy-to-change config mechanism as the rest of `guild-config.json` (not a separately mutable runtime store) — consistent with how `allowedRoles` already works there.

**Out of scope:**
- Attachments/image uploads on the send tool (text-only for v1).
- Onboarding tooling for adding more guilds — the config *shape* supports multiple guilds/per-guild whitelists, but only one guild is actually populated in v1; adding another is a manual config edit, not a self-service flow.
- Guild-membership-based auth (e.g. checking `guilds` scope) — whitelist is the sole gate, simplest and least likely to drift.
- A plain single-identity bot bridge (e.g. just adding another bot like Hermes) — rejected because it collapses all friends' agent output into one shared identity with no per-person attribution.
