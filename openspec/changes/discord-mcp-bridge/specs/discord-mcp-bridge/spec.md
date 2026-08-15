## ADDED Requirements

### Requirement: OAuth-gated MCP access via Discord identity
The MCP server SHALL require every client to authenticate via a Discord OAuth2 authorization-code flow (`identify` scope) before any tool call succeeds. The server SHALL use the Discord access token obtained during this flow only to resolve the caller's Discord identity (id, username, avatar) via `GET /users/@me`, and SHALL NOT accept or forward a caller-supplied identity for any purpose.

#### Scenario: Unauthenticated tool call is rejected
- **WHEN** an MCP client calls any tool without a valid session
- **THEN** the server rejects the call and the client is directed through the OAuth authorize flow

#### Scenario: Successful OAuth login resolves caller identity
- **WHEN** a user completes the Discord OAuth authorize/callback flow
- **THEN** the server resolves their Discord user id, username, and avatar from `GET /users/@me` and does not accept any identity fields the client itself supplied

### Requirement: Self-issued, short-lived MCP session token
The server SHALL mint its own opaque MCP access token after a successful Discord OAuth callback, rather than forwarding Discord's own access token to the client. The server SHALL use Discord's access token only once, to resolve the caller's identity via `GET /users/@me`, and SHALL NOT accept it as a bearer token on subsequent MCP requests. The server-issued token SHALL expire within approximately one hour of issuance. Tool-call authorization SHALL be based on validating this server-issued token, not on any Discord-issued token.

#### Scenario: Server issues its own token distinct from Discord's
- **WHEN** a user completes the Discord OAuth callback
- **THEN** the MCP session token returned to the client is a token minted by the server, not the Discord access token obtained during the callback

#### Scenario: Discord's access token is rejected as an MCP bearer token
- **WHEN** a client presents Discord's own OAuth access token directly as its MCP bearer token
- **THEN** the server rejects it, since only server-issued tokens are valid for tool calls

#### Scenario: Expired session token is rejected
- **WHEN** a client presents a server-issued token more than approximately one hour after issuance
- **THEN** the server rejects the tool call and the client must re-authenticate via OAuth

### Requirement: Per-guild whitelist authorization
The server SHALL maintain a whitelist of allowed Discord user ids per guild, configured in `guild-config.json`. At OAuth token verification, the server SHALL compute the full set of guild ids for which the authenticated Discord user id is whitelisted. If that set is empty, the server SHALL reject the session entirely. A user whitelisted in multiple guilds SHALL have access to all of them in one session.

#### Scenario: Whitelisted user in one guild gets scoped access
- **WHEN** a Discord user id appears in guild A's whitelist but not guild B's
- **THEN** their session's permitted-guild set is `{A}`, and tool calls targeting guild B are rejected

#### Scenario: User whitelisted in multiple guilds
- **WHEN** a Discord user id appears in both guild A's and guild B's whitelist
- **THEN** their session's permitted-guild set is `{A, B}`, and tool calls targeting either guild succeed

#### Scenario: Non-whitelisted user is rejected entirely
- **WHEN** a Discord user completes OAuth but their user id appears in no guild's whitelist
- **THEN** the server rejects token verification and the user gets no usable MCP session

#### Scenario: No channel-level restriction within an allowed guild
- **WHEN** a caller's session is authorized for a guild
- **THEN** any channel within that guild that the bot itself can access is a valid target for `fetch`, `search`, or `send` — no additional channel allowlist applies

### Requirement: Fetch channel messages tool
The MCP server SHALL expose a `fetch` tool that returns recent or ranged messages from a given `channel_id`, reusing the existing `fetchChannelMessages` logic. The server SHALL resolve the channel's actual guild and reject the call if that guild is not in the caller's permitted-guild set, before invoking the underlying fetch.

#### Scenario: Fetch from an allowed guild's channel
- **WHEN** a caller whose permitted-guild set includes guild A calls `fetch` with a `channel_id` belonging to guild A
- **THEN** the tool returns the requested messages

#### Scenario: Fetch from a channel outside the caller's permitted guilds
- **WHEN** a caller calls `fetch` with a `channel_id` belonging to a guild not in their permitted-guild set
- **THEN** the tool call is rejected and no message content is returned

### Requirement: Search messages tool with mandatory content filtering
The MCP server SHALL expose a `search` tool taking a required `guild_id` (and optional `channel_id`/other narrowing parameters), reusing the existing `searchMessages` logic. The server SHALL reject the call if the given `guild_id` is not in the caller's permitted-guild set. The tool SHALL NOT expose an `is_automod` parameter to callers and SHALL always query with `is_automod: false`. The tool SHALL filter out any result row with a non-null `deleted_at` before returning results, regardless of what the underlying query returns.

#### Scenario: Search scoped to an allowed guild
- **WHEN** a caller whose permitted-guild set includes guild A calls `search` with `guild_id` = A
- **THEN** the tool returns matching messages from guild A

#### Scenario: Search rejected for a disallowed guild
- **WHEN** a caller calls `search` with a `guild_id` not in their permitted-guild set
- **THEN** the tool call is rejected

#### Scenario: Deleted messages never appear in results
- **WHEN** the underlying search matches a message row with a non-null `deleted_at`
- **THEN** that row is excluded from the tool's response

#### Scenario: Automod-flagged messages never appear in results
- **WHEN** a caller's search would otherwise match a message flagged `is_automod`
- **THEN** that message is excluded from the tool's response, regardless of any parameter the caller sends

### Requirement: Send message tool with identity-attributed webhook delivery
The MCP server SHALL expose a `send` tool taking a required `channel_id` and message text. The server SHALL reject the call if the channel's guild is not in the caller's permitted-guild set. The tool SHALL post the message via a Discord channel webhook, setting the webhook's `username` and `avatar_url` from the caller's Discord identity resolved during OAuth — never from a client-supplied parameter. The tool's input schema SHALL NOT include any field that could supply an identity (name, display name, avatar) for the message. The tool SHALL be text-only in this version; it SHALL NOT accept attachments or file uploads.

#### Scenario: Message is posted under the caller's own identity
- **WHEN** a caller whose Discord identity is "Alice" calls `send` with a `channel_id` in an allowed guild and message text
- **THEN** the message appears in that channel via webhook with username and avatar matching Alice's Discord identity

#### Scenario: Send rejected for a disallowed guild
- **WHEN** a caller calls `send` with a `channel_id` belonging to a guild not in their permitted-guild set
- **THEN** the tool call is rejected and no message is posted

#### Scenario: Caller cannot override displayed identity
- **WHEN** a caller's tool call includes any additional field attempting to set a name or avatar
- **THEN** the server ignores it and uses only the caller's OAuth-resolved identity

#### Scenario: Attachments are not supported
- **WHEN** the `send` tool's input schema is inspected
- **THEN** it contains no field for a file, image, or attachment — only channel and message text — so no client can supply one

### Requirement: Per-channel webhook reuse
The server SHALL reuse an existing Discord webhook for a channel when posting via `send`, rather than creating a new one per message. It SHALL create a webhook only if none owned by the bot's own application already exists in that channel. Webhook identifiers SHALL be cached in memory for the process lifetime and SHALL NOT be persisted to disk or database.

#### Scenario: Existing webhook is reused
- **WHEN** a channel already has a webhook created by the bot's application
- **THEN** subsequent `send` calls to that channel reuse it rather than creating a new one

#### Scenario: Webhook created on first use
- **WHEN** a channel has no webhook owned by the bot's application
- **THEN** the server creates one before posting

#### Scenario: Cache self-heals within the same send call after external webhook deletion
- **WHEN** a cached webhook has been deleted outside the bot (e.g. by a server admin) and a send attempt's execute call receives a 404
- **THEN** the server evicts the stale cache entry, creates a replacement webhook, retries the send once within that same tool call, and the caller's message is still delivered
