# sushii-agent

Discord moderation intelligence bot. Caches server messages locally and answers moderator queries via natural language using an LLM agent loop.

## How it works

Mention the bot in a whitelisted channel with a plain-English question. It creates a thread, runs a tool-calling agent against the local message cache, and posts a synthesized response. Follow-up messages in the same thread resume the conversation.

```
@ModAssist has user 123456789 been causing problems recently?
@ModAssist show me what was said in #general around that deleted message
@ModAssist what channels does this user post in most?
```

The bot is **read-only** — it never writes moderation actions.

## Features

- **30-day message cache** — all messages from configured guilds are stored in SQLite with FTS5 full-text search
- **Agent loop** — the LLM calls tools iteratively until it has enough context to answer
- **Thread-scoped conversations** — each thread is an independent session; context persists across bot restarts
- **Soft deletes** — deleted messages are tombstoned, not removed, so they remain available as evidence
- **Multi-guild** — a single bot process can serve multiple servers with independent configs
- **Provider-agnostic** — works with any OpenAI-compatible API (Anthropic, OpenRouter, local models)

## Agent tools

| Tool | Description |
|---|---|
| `search_messages` | FTS5 full-text search with optional user/channel/time filters |
| `get_conversation_context` | Messages surrounding a specific message ID, with reply chain |
| `get_user_profile` | Activity summary — first seen, message count, channel distribution, daily frequency |
| `get_recent_activity` | Most recent N messages from a user across all channels |
| `get_current_member_info` | Live Discord API — current roles, join date, still in server? |

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- A Discord bot token with **Message Content** and **Server Members** privileged intents enabled

### Discord bot permissions

When adding the bot to a server, it needs:
- Read Messages / View Channels
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Read Message History

### Install

```bash
git clone <repo>
cd sushii-agent
bun install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.anthropic.com/v1
OPENAI_MODEL=claude-opus-4-6
DATABASE_PATH=./data/modassist.db

# Which users and channels are allowed to query the bot, per guild
GUILD_CONFIG={"YOUR_GUILD_ID": {"allowedUsers": ["MOD_USER_ID_1", "MOD_USER_ID_2"], "allowedChannels": ["MOD_CHANNEL_ID"]}}
```

**Finding IDs:** Enable Developer Mode in Discord (Settings → Advanced), then right-click any server/user/channel to copy its ID.

`allowedChannels` also covers threads whose parent channel is listed — so if a mod-mail forum channel is whitelisted, bot mentions inside its threads work automatically.

### Run

```bash
bun src/index.ts
```

### Docker

```bash
# Copy and fill in .env first
docker compose up -d
```

The `./data` directory is mounted as a volume for the SQLite database.

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | — | Bot token from Discord Developer Portal |
| `OPENAI_API_KEY` | yes | — | API key for your LLM provider |
| `OPENAI_BASE_URL` | no | `https://api.anthropic.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_MODEL` | no | `claude-opus-4-6` | Model name passed to the API |
| `DATABASE_PATH` | no | `./data/modassist.db` | Path to the SQLite database file |
| `GUILD_CONFIG` | yes | — | JSON object mapping guild IDs to access config |

### Using other providers

```env
# OpenRouter
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4o

# Local (Ollama)
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.1
```

## Architecture

```
messageCreate → insertMessage (SQLite)
             ↘ if @mention + whitelisted
                → resolveOrCreateThread
                → loadConversation (SQLite)
                → runAgentLoop
                   ├─ LLM call (OpenAI-compat API)
                   ├─ tool_calls → runTools → SQLite queries / Discord API
                   └─ repeat until finish_reason: stop
                → thread.send(response)
                → saveConversation (SQLite)
                → renameThread (if new thread)
```

### Database schema

```sql
messages       (discord_id, guild_id, channel_id, author_id, content,
                reply_to_id, created_at, edited_at, deleted_at)
messages_fts   -- FTS5 external content table over messages.content
conversations  (thread_id, guild_id, messages JSON, created_at, updated_at)
```

WAL mode is enabled. Messages older than 30 days are purged daily.

## Development

```bash
bun --watch src/index.ts   # auto-restart on file changes
```

Type-check without running:

```bash
bunx tsc --noEmit
```

## Out of scope (v1)

- Writing moderation actions (warnings, kicks, bans)
- Cross-server search
- Semantic / embedding-based search
- `@ModAssist clear` to reset thread context
- Web dashboard
