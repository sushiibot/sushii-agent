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

## Background task messaging

The Pi runner exposes `send_owner_message` to a running background agent. It writes a durable, task-addressed mailbox record, then DM-notifies the task owner without waiting; the runner continues its current task. The owner can reply to that specific Discord DM message. Replies are recorded and sent to the same task via the runner's ordinary `followUp` queue (not `steer_task`, `ask_owner`, cancellation, or interrupt), so they wait until current work finishes. If the task is idle, the reply resumes that task. Failure to send/route is reflected in the mailbox status and owner-facing error.

Delivery records are stored in SQLite (`task_messages`) with `pending`, `delivered`, or `failed` status. Pending agent messages are retried after bot restart. Discord delivery is deliberately limited to tasks created from the Discord surface; other task origins currently have no notification/reply surface. A crash between Discord accepting a DM and persisting its message ID can cause a duplicate notification on retry.

This differs from `ask_owner`: that tool intentionally blocks a task and routes the reply as an answer. `steer_task` intentionally redirects/supersedes work. Use the mailbox only for non-blocking communication.

Current runner support: Pi supports the complete send/reply path. Claude Code is a one-shot CLI adapter and does not expose an in-progress agent tool or non-superseding follow-up queue; its replies are therefore rejected while running rather than falling back to a steer. It can accept an owner reply only after it has settled idle, when the orchestrator resumes the native session normally.

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
- `trustSpaceMembers` extends trust to anyone posting from this team's non-Discord spaces (see the
  entry-gate docs for the exact semantics).

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

## Development

```bash
bun --watch src/index.ts   # auto-restart
bunx tsc --noEmit          # type-check
```
