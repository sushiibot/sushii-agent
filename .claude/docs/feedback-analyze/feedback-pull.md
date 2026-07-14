# Pulling Agent Feedback

User feedback is collected when users click the 👍/👎 buttons on agent responses. Each submission writes a JSON file to the server.

## File locations

| Location | Path |
|---|---|
| Container | `/data/feedback/` |
| Host (via docker volume) | `/opt/services/private-bots/sushii-agent/data/feedback/` |
| Remote host | `sushiiapps` |

## Pull command

Copy then delete from server (move semantics — avoids reprocessing old files):

```bash
scp -r sushiiapps:/opt/services/private-bots/sushii-agent/data/feedback/ ./feedback-export/ && \
ssh sushiiapps "rm /opt/services/private-bots/sushii-agent/data/feedback/*.json"
```

Files land in `feedback-export/feedback/` (excluded from git via `.gitignore`).

## Feedback JSON schema

```json
{
  "threadId": "...",
  "guildId": "...",
  "userId": "...",
  "username": "...",
  "sentiment": "positive" | "negative",
  "feedback": "...",
  "timestamp": "ISO8601",
  "conversation": [/* AI SDK message history */]
}
```

## Implementation

- `src/feedback.ts` — `saveFeedback(entry)` writes JSON to `config.feedbackPath`
- `src/config.ts` — `feedbackPath` field, env var `FEEDBACK_PATH`, default `./data/feedback`
- `src/bot.ts` — `sendFeedbackButtons()`, `handleFeedbackButton()`, `handleFeedbackModal()`
