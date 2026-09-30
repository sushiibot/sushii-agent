# sushii-agent

Discord moderation intelligence bot. Mention it in a whitelisted channel with a plain-English question — it creates a thread, runs a tool-calling agent against a local message cache, and posts a synthesized answer. Follow-ups in the same thread resume the conversation.

```
@sushii-agent has user 123456789 been causing problems recently?
@sushii-agent show me what was said in #general around that deleted message
@sushii-agent what channels does this user post in most?
```

**Read-only** — never writes moderation actions.

## Features

- **30-day message cache** — SQLite with FTS5 full-text search
- **Agent loop** — LLM calls tools iteratively until it has enough context
- **Thread-scoped conversations** — independent sessions, persist across restarts
- **Soft deletes** — deleted messages are tombstoned, not removed
- **Multi-guild** — single process, per-guild config
- **Provider-agnostic** — any OpenAI-compatible API (Anthropic, OpenRouter, local)

## Agent tools

| Tool | Description |
|---|---|
| `search_messages` | FTS5 full-text search with optional user/channel/time filters |
| `get_conversation_context` | Messages around a message ID, with reply chain |
| `get_user_profile` | First seen, message count, channel distribution, daily frequency |
| `get_recent_activity` | Most recent N messages from a user across all channels |
| `get_current_member_info` | Live Discord API — roles, join date, membership status |

## Setup

**Prerequisites:** [Bun](https://bun.sh) v1.0+, a Discord bot token with **Message Content** and **Server Members** privileged intents, and bot permissions: Read Messages, Send Messages, Create/Send in Threads, Read Message History.

```bash
git clone <repo> && cd sushii-agent
bun install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.anthropic.com/v1   # or OpenRouter, Ollama, etc.
OPENAI_MODEL=claude-opus-4-6
DATABASE_PATH=./data/sushii-agent.db
```

Create `teams.json` from `teams.example.json` — it's the only source of per-space configuration:

```json
{
  "your-team": {
    "spaces": [
      {
        "surface": "discord",
        "spaceId": "YOUR_GUILD_ID",
        "discord": {
          "allowedRoles": ["MOD_ROLE_ID"],
          "emojis": ["<:blobheart:123456789012345678>"],
          "promptTemplate": "general",
          "enabledModules": ["moderation"]
        }
      }
    ]
  }
}
```

**Finding IDs:** Enable Developer Mode (Settings → Advanced), then right-click any server/user/channel to copy its ID.

```bash
bun src/index.ts          # run
docker compose up -d      # or Docker (./data volume for SQLite)
```

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | — | Bot token from Discord Developer Portal |
| `OPENAI_API_KEY` | yes | — | API key for your LLM provider |
| `OPENAI_BASE_URL` | no | `https://api.anthropic.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_MODEL` | no | `claude-opus-4-6` | Model name |
| `DATABASE_PATH` | no | `./data/sushii-agent.db` | SQLite path |
| `PRINCIPALS_PATH` | no | `./principals.json` | Path to the manual cross-platform identity registry; missing file = unconfigured |
| `TEAMS_PATH` | no | `./teams.json` | Path to the team grouping config — the only source of per-space configuration; missing file = unconfigured |

A `teams.json` entry groups a team's spaces (Discord guild, Slack workspace, buzz relay) plus its
own wiki/Linear scoping, trusted members, and each space's own settings. See `teams.example.json`
for a full worked entry.

```json
{
  "dreamcatcher": {
    "spaces": [
      {
        "surface": "discord",
        "spaceId": "123456789012345678",
        "wiki": "source",
        "statusChannelId": "234567890123456789",
        "discord": {
          "allowedRoles": ["MOD_ROLE_ID"],
          "emojis": ["<:blobheart:123456789012345678>"],
          "promptTemplate": "general",
          "enabledModules": ["moderation"]
        }
      },
      { "surface": "slack", "spaceId": "T000TEAMA0", "wiki": "read" },
      {
        "surface": "buzz",
        "spaceId": "buzz:https://relay.example",
        "wiki": "read",
        "buzz": { "avatarUrl": "https://relay.example/avatar.png" }
      }
    ],
    "wiki": { "wikiId": "123456789012345678" },
    "members": { "some-principal-id": { "trusted": true } },
    "linear": { "teamId": "DREAM", "apiKeyEnv": "DREAMCATCHER_LINEAR_API_KEY" },
    "trustSpaceMembers": false
  }
}
```

- `wiki.wikiId` names the wiki this team owns; a space feeds it (`wiki: "source"`) and/or reads it
  (`wiki: "read"`). Wiki participation is entirely determined by these two fields — there's no
  other way for a space to feed or read a wiki.
- `discord` takes the same shape as `GuildConfig` (`allowedRoles` required) and is only allowed on
  a `surface: "discord"` space. It's the sole source of `config.guildConfig`, keyed by the space's
  `spaceId`, with the space's own `statusChannelId` folded in as `wiki.statusChannelId` — set
  `statusChannelId` on the space itself, not `discord.wiki.statusChannelId` (rejected at load).
- `buzz.avatarUrl` is only allowed on a `surface: "buzz"` space, and takes precedence over the
  global `BUZZ_AVATAR_URL` fallback for that relay.
- `linear.apiKeyEnv` names the env var holding the team's Linear API key, read at resolve time.
- `trustSpaceMembers` — see [Permissions](#permissions).

## Permissions

Two independent layers.

**Entry gate — who can trigger the bot at all, per surface.** Discord guilds are public spaces:
only a member holding one of the guild's `allowedRoles` can mention/reply to trigger the bot — this
applies to everyone, including the owner. Slack workspaces and buzz relays are private and
invite-only, so being in the space is itself the gate; there's no role check there.
`enabledModules`/`moderation` never gates this — a guild with no modules enabled still gets chat as
long as it's configured. `moderation` only turns on moderation features: the auto-mod trigger
(pinging `modRoleId`), moderation-only tools, and the "Moderator:/Roles:" prompt lines.

**Trust — which tools.** The owner, or a member listed as `trusted` in the space's team
(`members` above), gets `team_config` and ops-triage tools. `trustSpaceMembers`
extends this: set it `true` on a team whose Slack/buzz spaces are already invite-only vetting, and
any caller present in one of those spaces is trusted — no `members` entry needed. It never applies
to a Discord space, since Discord guilds are public and need an explicit trusted member or the
owner.

## Architecture

```
messageCreate → insertMessage (SQLite)
             ↘ if @mention + whitelisted
                → resolveOrCreateThread
                → loadConversation (SQLite)
                → runAgentLoop
                   ├─ LLM call (OpenAI-compat API)
                   ├─ tool_calls → runTools → SQLite / Discord API
                   └─ repeat until stop
                → thread.send(response)
                → saveConversation (SQLite)
                → renameThread (if new)
```

**Schema:**
```sql
messages       (discord_id, guild_id, channel_id, author_id, content,
                reply_to_id, created_at, edited_at, deleted_at)
messages_fts   -- FTS5 external content table
conversations  (thread_id, guild_id, messages JSON, created_at, updated_at)
```

WAL mode. Messages older than 30 days purged daily.

## Personal agent workspace

The owner's DMs go to a long-lived Pi coding-agent session in its own container
(`src/workspace/`, image tag `<sha>-workspace`, service `private-bots/sushii-agent-workspace`), not
to the in-process loop. The bot is the transport: it relays chat over a JSON-RPC WebSocket
(`src/orchestration/workspace/`), proxies bot-side tools (Exa, Grafana, Linear, `team_config`) with
owner approval for writes, and mints GitHub App tokens so `git`/`gh` run as `sushii-runner[bot]`.
If the workspace is down, DMs fall back to the in-process loop. Guild, thread, Slack and buzz
traffic stays in-process.

- **Home** (`/data/home`, git-versioned): `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `TASKS.md`
  are loaded into every session; `memory/`, `tasks/<project>.md` and `DREAMS.md` are read on demand.
  Unedited template files upgrade themselves on start.
- **Models:** ChatGPT sign-in first (main, subagents, jobs and the auto-mode judge share one
  backend), OpenRouter when the subscription is out.
- **Context:** old tool output is cleared at 150K tokens; compaction (anchored summary, sent as a
  cached continuation) at 200K keeping 40K; after 25 idle minutes over 100K the session rotates to
  a new one seeded with a recap.
- **Jobs:** nightly memory consolidation, heartbeat with daily task review, `~/schedule.md`.
- **Commands** (owner DM): `!new`, `!stop`, `!compact`, `!model [alias]`, `!tasks [project]`,
  `!login chatgpt`.
- **Run history:** `runs.jsonl` in the state dir; `ws-runs` inside the container.

Deploy: pushing to `main` builds both images and redeploys the bot only. The workspace deploys on
its own: bump `workspace_image_tag` in sushii-ansible, then
`./deploy.sh -y apps private-bots/sushii-agent-workspace`. Tunables (`WORKSPACE_MODELS`,
`WORKSPACE_COMPACT_TOKENS`, `WORKSPACE_TASK_*`, …; defaults in `src/workspace/config.ts`) go in
`workspace_env_overrides` there. `DM_WORKSPACE_ENABLED` on the bot routes owner DMs to it.

## Development

```bash
bun --watch src/index.ts   # auto-restart
bunx tsc --noEmit          # type-check
```
