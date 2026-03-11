# ModAssist

**Discord Moderation Intelligence Bot**
Product Definition Document • v0.2 • March 2026

---

## Overview

ModAssist is a read-only Discord moderation intelligence bot that helps moderators quickly gather context around incidents, users, and mod mail complaints. It collapses the manual work of digging through channels, checking logs, and recalling past cases into a single natural language interaction.

---

## Problem

Moderators spend significant time on context-gathering before making decisions. A mod mail arrives and they must manually:

- Search message history for relevant conversations
- Recall or look up prior incidents involving the user
- Reconstruct the thread and reply context around an incident
- Cross-reference with other moderators on recent activity

This is slow, inconsistent, and relies on individual moderator memory.

---

## Solution

A single-process Discord bot that:

- Listens to all server messages and maintains a 30-day local SQLite cache
- Accepts natural language queries from whitelisted moderators via @mention
- Runs an LLM agent loop (Claude) with a set of read-only tools against the cache
- Returns a synthesized summary with relevant context directly in Discord

---

## Access Model

- **Whitelisted users only** — moderators explicitly enumerated in config
- **Whitelisted channels only** — specific mod-only channels or forum threads
- **Guild-scoped** — all queries are strictly scoped to the server they originate from. No cross-server search in v1.

---

## Context & Conversation

The bot uses Discord threads as the natural session boundary, mirroring the UX of LLM chat apps.

**Thread lifecycle:**

1. Mod mentions bot in a regular channel → bot creates a thread on that message → agent runs → thread is renamed to a concise topic name (e.g. *"User 12345 — recent activity check"*) generated via a secondary LLM call after the response
2. Mod mentions bot inside an existing thread (e.g. mod mail forum thread) → bot replies in-thread, no new thread created
3. All follow-up mentions within the same thread resume the existing conversation context

**Context key is always `thread_id`** — no timeouts, no per-channel heuristics. The thread is the session.

**Persistence** — conversations are stored in SQLite so context survives bot restarts. On startup, active conversations are loaded back into the in-memory map.

**Clear command** — a `@ModAssist clear` command inside a thread resets its context. Deferred to post-v1.

---

## Agent Tools

All tools are read-only. The agent decides which tools to call and may chain multiple calls before returning a response.

| Tool | Key Options | Description |
|---|---|---|
| `search_messages` | `query, user_id?, channel_id?, since?, until?, limit?` | FTS5 full-text search against the message cache |
| `get_conversation_context` | `message_id, window?` | Messages before/after a given message, preserving reply chain |
| `get_user_profile` | `user_id` | Activity summary — first seen, channel distribution, message frequency |
| `get_recent_activity` | `user_id, days?, limit?` | Recent messages across all channels for tone/behavior context |
| `get_current_member_info` | `user_id` | Live Discord API call — current roles, join date, still in server? |

> **Note:** Moderation history (warnings, bans, kicks) is out of scope for v1. If the moderation bot posts structured log messages to a dedicated channel, `search_messages` scoped to that channel is a viable workaround.

---

## Architecture

Single process. No MCP server. No separate ingestion service.

| Layer | Responsibility |
|---|---|
| Bot listener | Captures all `messageCreate` events → buffers → batch writes to SQLite every 10–30s |
| Mention handler | Whitelist check → strips mention → resolves or creates thread → loads context → calls agent |
| Thread manager | Creates threads on regular channel mentions, renames thread after first response |
| Agent loop | Manual Claude API loop: send → tool calls → append results → repeat until `end_turn` |
| Tool functions | Direct SQLite queries + one live Discord API call (`get_current_member_info`) |
| SQLite (WAL) | Message cache (30 days) + conversation store + FTS5 virtual table |

---

## Key Schema

```sql
messages (id, discord_id, guild_id, channel_id, author_id, content,
          reply_to_id, created_at, edited_at, deleted_at)

messages_fts  -- FTS5 virtual table: content, author_id UNINDEXED, channel_id UNINDEXED

conversations (thread_id, guild_id, messages JSON, created_at, updated_at)
```

- `guild_id` on every row — required for query scoping
- `reply_to_id` — preserves conversation thread structure
- `deleted_at` — tombstone deletes, don't hard-delete (moderation relevance)
- `conversations.messages` — full message array serialized as JSON, rehydrated on startup
- WAL mode enabled — readers don't block batch writers

---

## Out of Scope (v1)

- Writing moderation actions (warnings, kicks, bans)
- Integration with external moderation bot API
- Cross-server search
- `@ModAssist clear` command
- Semantic / embedding-based search
- Web dashboard or non-Discord interface

---

## Stack

| | |
|---|---|
| Runtime | Bun |
| Language | TypeScript |
| Discord library | discord.js |
| LLM | Claude via Anthropic SDK, manual agent loop |
| Database | SQLite via better-sqlite3, FTS5, WAL mode |
| Deployment | Single process, Hetzner VPS, Docker Compose |
