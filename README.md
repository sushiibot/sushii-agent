# sushii-agent

AI agent community bot for Discord, Slack and buzz. Mention it with a plain-English question. It
runs a tool-calling agent against a local message cache and the platform's API, then posts an
answer. Follow-ups in the same thread continue the conversation.

```
@sushii-agent has user 123456789 been causing problems recently?
@sushii-agent show me what was said in #general around that deleted message
@sushii-agent what channels does this user post in most?
```

The personal agent lives in [sushiibot/omakase](https://github.com/sushiibot/omakase).

## Features

- **Message cache**: Discord messages in SQLite with FTS5 search, retained for at most 30 days.
- **Thread conversations**: each thread is its own session and survives restarts.
- **Per-team config**: one process serves many Discord guilds, Slack workspaces and buzz relays.
- **Modules** per Discord guild (`enabledModules`):
  - `moderation`: the auto-mod flow, triggered by pinging `modRoleId`, can time out members,
    delete messages and post an alert.
  - `screening`: checks new members.
  - `ops-triage`: Grafana and Linear tools.
  - `mcp`: sushii MCP tools.
- **Wiki sync**: summarizes channel history into a git-backed wiki on a schedule.
- **MCP server**: exposes tools to external MCP clients over HTTP with Discord OAuth.
- **Provider-agnostic**: any OpenAI-compatible API (Anthropic, OpenRouter, local).

## Setup

**Prerequisites:** [Bun](https://bun.sh) and a Discord bot token with the **Server Members**
privileged intent. Turn on **Message Content** once it is approved (see `DISCORD_MESSAGE_CONTENT`).
Bot permissions: Read Messages, Send Messages, Create/Send in Threads, Read Message History. The
`moderation` module also needs Moderate Members (timeouts), Manage Messages (deletes), View Audit
Log and Manage Server (AutoMod rules).

```bash
bun install
cp .env.example .env               # fill in DISCORD_BOT_TOKEN and OPENAI_API_KEY
cp teams.example.json teams.json   # replace the IDs with your own
bun src/index.ts
```

To find IDs, turn on Developer Mode (Settings → Advanced), then right-click a server, user or
channel and copy its ID.

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | — | Bot token from the Discord Developer Portal |
| `OPENAI_API_KEY` | yes | — | API key for your LLM provider |
| `OPENAI_BASE_URL` | no | `https://api.anthropic.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_MODEL` | no | `claude-opus-4-6` | Model name |
| `DATABASE_PATH` | no | `./data/sushii-agent.db` | SQLite path |
| `DISCORD_MESSAGE_CONTENT` | no | `false` | Set `true` once the Message Content intent is approved. When off, the bot reads only messages that mention it, and message caching, wiki sync, server auto-scan, screening and the auto-mod trigger are off |
| `TEAMS_PATH` | no | `./teams.json` | Team config, the only source of per-space configuration. A missing file means nothing is configured |
| `PRINCIPALS_PATH` | no | `./principals.json` | Cross-platform identity registry. A missing file means none |
| `OWNER_DISCORD_ID` | no | — | Creates a single owner principal when the registry is empty |

Optional integrations (see `src/config.ts`):

- Slack: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
- buzz: `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL`, `BUZZ_AUTH_TAG`, `BUZZ_DISPLAY_NAME`, `BUZZ_AVATAR_URL`
- Wiki sync: `WIKI_SYNC_REPO_URL`, `WIKI_SYNC_HTTPS_TOKEN` (or `WIKI_SYNC_SSH_PRIVATE_KEY_B64`, read by
  the Docker entrypoint), other `WIKI_SYNC_*` tuning
- Memory backend: `MNEMOSYNE_MCP_URL`, `MNEMOSYNE_MCP_TOKEN`. Without them, memory stays in SQLite.
- sushii MCP tools: `SUSHII_MCP_URL`, `SUSHII_MCP_TOKEN`
- Ops triage: `GRAFANA_BASE_URL`, `GRAFANA_API_TOKEN`, `LINEAR_API_KEY`, `LINEAR_TEAM_ID`
- MCP server (always listens on `MCP_BRIDGE_PORT`, default `8787`): OAuth needs `DISCORD_OAUTH_CLIENT_ID`,
  `DISCORD_OAUTH_CLIENT_SECRET`, `DISCORD_OAUTH_REDIRECT_URI`
- Web search: `EXA_API_KEY`
- Telemetry: `OTEL_EXPORTER_OTLP_ENDPOINT`

### teams.json

Each entry groups a team's spaces (Discord guild, Slack workspace, buzz relay) with its wiki,
Linear scoping, trusted members and per-space settings. See
[`teams.example.json`](teams.example.json) for a full entry.

- `wiki.wikiId` names the team's wiki. A space feeds it (`wiki: "source"`) or reads it
  (`wiki: "read"`). Only these two fields control wiki participation.
- `discord` is allowed only on a `surface: "discord"` space and takes the `GuildConfig` shape
  (`allowedRoles` required). Set `statusChannelId` on the space itself, not inside `discord`.
- `buzz.avatarUrl` is allowed only on a `surface: "buzz"` space and overrides `BUZZ_AVATAR_URL`.
- `linear.apiKeyEnv` names the env var that holds the team's Linear API key.
- `trustSpaceMembers`: see [Permissions](#permissions).

## Permissions

Two independent layers.

**Entry gate: who can trigger the bot.** Discord guilds are public, so only a member with one of
the guild's `allowedRoles` can trigger the bot, the owner included. Slack workspaces and buzz
relays are invite-only, so membership is the gate. `enabledModules` does not affect this: a guild
with no modules still gets chat.

**Trust: which tools.** The owner, or a member marked `trusted` in the team's `members`, gets
`team_config` and the ops-triage tools. With `trustSpaceMembers: true`, anyone in one of the
team's Slack or buzz spaces is trusted. It never applies to Discord spaces.

## Architecture

```
src/index.ts
  ├─ src/surfaces/{discord,slack,buzz}   platform gateways: ingest, triggers, delivery
  ├─ src/core/agentCore.ts, loop.ts      agent loop (AI SDK) and tool registry (src/core/tools)
  ├─ src/modules/                        moderation, screening, ops-triage, wiki-sync
  ├─ src/mcp/server/                     HTTP MCP server with Discord OAuth
  └─ src/db/                             SQLite (Drizzle, WAL mode); schema in src/db/schema.ts
```

Migrations live in `drizzle/`.

## Message and transcript retention

Raw Discord messages, conversation transcripts, screening records, feedback and raw wiki-sync
scratch files have a 30-day maximum. Startup and hourly cleanup delete at 29 days for scheduling
headroom. Cache/conversation/screening reads enforce the 30-day boundary independently. Conversations
expire by creation time, even when active; an in-flight turn cannot resurrect an expired transcript.
Curated wiki pages and persistent memory remain separate and do not expire on this schedule.

Feedback no longer duplicates conversations, unflagged screening checks retain no message snapshot,
and screening/wiki logs omit message bodies and model/tool payloads. New wiki sessions run in memory;
raw inboxes are removed after a sweep, including failures. Existing raw scratch files are aged out.

The retention migration enables FTS5 secure deletion (SQLite 3.42+), rebuilds the message index and
adds cleanup indexes. SQLite secure deletion and WAL truncation complement encrypted storage; they
do not erase external backups, existing log exports or content already posted to Discord.

Before deploying, verify encrypted storage and backup expiry. A stopped process cannot erase data:
cleanup runs before requests are served on restart. Backups must expire by the content's deadline,
not simply 30 days after the backup was made. Existing plaintext copies and old exports need a
separate migration cleanup. The database migration rebuilds FTS once, so allow startup time and disk
headroom for a large cache.

## Scripts

- `scripts/generate-buzz-auth-tag.ts`: creates the owner-attestation tag for `BUZZ_AUTH_TAG`.
- `scripts/upload-buzz-avatar.ts`: uploads an avatar to a buzz relay and prints the URL for `BUZZ_AVATAR_URL`.

## Development

```bash
bun dev                            # watch mode with pretty logs
bunx tsc --noEmit                  # type-check
OPENAI_API_KEY=dummy bun test      # tests
```

See [PRIVACY.md](PRIVACY.md) and [TOS.md](TOS.md) for the bot's privacy policy and terms.
