# Feedback Analysis

Scripts for inspecting feedback exports. See `feedback-pull.md` for how to pull files from the server.

## Scripts

All scripts take a feedback JSON file as the first argument (except `batch_summary.py`).

```bash
# Quick overview of one file
uv run scripts/summary.py feedback-export/feedback/<file>.json

# Find empty/silent assistant responses
uv run scripts/empty_responses.py feedback-export/feedback/<file>.json

# Print all assistant text responses
uv run scripts/responses.py feedback-export/feedback/<file>.json

# Full conversation dump with role labels
uv run scripts/conversation.py feedback-export/feedback/<file>.json

# Summarize all files in a directory
uv run scripts/batch_summary.py feedback-export/feedback/
```
