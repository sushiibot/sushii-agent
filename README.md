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
GUILD_CONFIG={"YOUR_GUILD_ID": {"allowedRoles": ["MOD_ROLE_ID"], "allowedChannels": ["MOD_CHANNEL_ID"]}}
```

**Finding IDs:** Enable Developer Mode (Settings → Advanced), then right-click any server/user/channel to copy its ID.

`allowedChannels` also matches threads whose parent channel is listed.

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
| `GUILD_CONFIG` | yes | — | JSON mapping guild IDs to access config |
| `GUILD_CONFIG_PATH` | no | — | Path to a JSON file instead of inline JSON |

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
