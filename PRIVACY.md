# Privacy Policy — sushii-agent

Last updated: October 16, 2026

This policy covers the sushii-agent Discord application ("the bot", "we", "us"). It is
separate from, and does not apply to, other sushii bots or services.

## What we collect

When a server admin enables sushii-agent and a user interacts with it (by mentioning it,
replying to it, or using it in a channel where it's been enabled), we may collect and store:

- Discord user ID, username, and display name of participants in the conversation
- The text content of messages sent to or read by the bot as part of that interaction
- Server (guild) and channel IDs relevant to the interaction

We do not collect message content from channels or messages the bot is not actively
responding to.

## How we use it

- **To generate responses.** Message content is sent to our LLM provider (OpenRouter,
  which routes to underlying model providers) to produce the bot's replies. We configure
  these requests to deny routing to any provider that would collect or train on the data
  (`data_collection: deny`) — see [OpenRouter's provider routing docs](https://openrouter.ai/docs/guides/routing/provider-selection)
  for how this is enforced upstream.
- **To maintain conversation context.** Recent messages in a thread are stored so the bot
  can hold a coherent conversation across multiple turns.
- **To remember guild-specific context.** With admin approval, the bot may store a small
  set of notes about a server (e.g. rules, common questions) to answer more accurately in
  the future.

We do not use message content to train machine learning or AI models, and we do not sell,
share, or disclose it to third parties except as described above (our LLM provider) or as
required by law.

**We do not sell your personal information**, and we do not share it for cross-context
behavioral advertising. This applies regardless of your jurisdiction.

## Sub-processor

**OpenRouter** (openrouter.ai) is the only third party we send message content to, and
only for the purpose of generating the bot's replies. OpenRouter routes each request to
an underlying model provider on our behalf; we restrict that routing to providers that do
not collect or train on the data (see above). We do not use any other third-party
processor for message content.

## Legal basis for processing

Where GDPR or a similar law applies, we process your data under **legitimate interest**
(Art. 6(1)(f)): providing the bot's functionality is the entire reason it's invoked, and
processing is limited to what's necessary for that — we don't use the data for anything
you wouldn't reasonably expect from interacting with the bot. Where a server admin has
enabled a feature that requires storing additional context (e.g. server memory notes), we
rely on that admin's authority to configure the bot for their server, consistent with
**contract performance** (Art. 6(1)(b)) between us and the server.

## Retention

| Data | Retention |
|---|---|
| Cached Discord message content | Up to 30 days from the message timestamp |
| Conversation transcripts, including tool results and initial context | Up to 30 days from the conversation record's creation; continued activity does not extend its lifetime |
| Screening verdicts and flagged-message evidence | Up to 30 days from the screening record's creation |
| Submitted feedback | Up to 30 days; no separate conversation snapshot is stored |
| Pending questions | Up to 24 hours |
| Raw wiki-sync inbox files and legacy session transcripts | Up to 30 days; new wiki sessions run in memory and inbox files are removed when the sweep finishes |
| Curated wiki knowledge and persistent memory | Kept while needed for the enabled feature, until removed; not subject to the message/transcript expiry |

Scheduled cleanup starts at 29 days and runs at startup and hourly, leaving headroom
before the 30-day limit. Cache, conversation, and screening reads also enforce expiry.
If the service is stopped, cleanup runs before it resumes serving requests. A conversation
that expires starts with fresh stored context on the next interaction.

We keep curated wiki knowledge and memory separately from raw message history. The local
memory store allows up to 100 entries per space; an external memory backend may also be
configured. Removing a source message or expiring a transcript does not automatically
remove derived wiki knowledge or memory. Deletion requests can include these stores.

## Requesting deletion

You can ask us to delete your data (message history and any stored conversation context)
at any time by emailing **contact@sushii.xyz** or messaging us in our
[Discord support server](https://discord.gg/PjDRRXSSAF). Include your Discord user ID and
the server(s) you'd like data removed from. We'll confirm once it's done.

## Security

We use commercially reasonable measures to protect stored data from unauthorized access,
including restricted infrastructure access and secure hosting. Data storage is not
currently encrypted at rest; we're working on this and will update this policy when it
changes.

## Children's privacy

sushii-agent is not intended for use by anyone under the age of 13, or the minimum age
required by the laws of their country. If you believe a child has provided us data through
the bot, contact us and we'll remove it.

## Changes to this policy

We may update this policy from time to time. Material changes will be reflected by an
updated "Last updated" date above.

## Contact

- Email: contact@sushii.xyz
- Discord support server: https://discord.gg/PjDRRXSSAF
