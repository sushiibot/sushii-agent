---
name: session-history
description: Look up your own past runs and transcripts with the ws-runs CLI. Use when asked what you did earlier ("what did I do yesterday", "what did we decide about X last week"), what a subagent or scheduled job found, or when debugging one of your own past runs.
---

# Session history

Every run you do is logged: each chat turn, each subagent, each scheduled job. The run index lists
them all, and each run points at the full Pi transcript it wrote. `ws-runs` is the only way to read
them. The session files sit in the Pi agent dir, which the secret guard blocks for `read`, `grep`
and `bash`, so don't try to open them directly.

## Commands

```sh
ws-runs list [--limit N] [--agent NAME] [--parent [RUNID]] [--since ISO]
ws-runs show [runId] [--full]
ws-runs search <text> [--limit N]
```

Your current run's id is in `$WS_RUN_ID` (set in every bash command you run). `ws-runs list` prints
it on its first line, `ws-runs show` with no runId shows the current run, and a bare `--parent`
lists the current run's children.

- `list`: newest runs first, with status, agent (`main`, a subagent name, or `job:<name>`), parent
  run, duration, tokens and task. `--since 2026-09-28` limits it to runs started after that time;
  `--parent <runId>` lists a run's children. Runs are ordered by their last update, so a long run that
  just finished can sort above runs that started after it.
- `show`: the run's record plus a condensed transcript of that run only: user and assistant text,
  one line per tool call, and tool results cut to 300 chars. Add `--full` for complete tool output.
- `search`: a case-insensitive text search across every session file, newest first. Each hit prints
  the run id (or `-` if no run covers it), the session file, a timestamp and a snippet. Your own
  `ws-runs` commands and their output are left out of the results.

## How to use it

- "What did I do yesterday?": `ws-runs list --since <yesterday's date> --limit 50`, then `show`
  the runs that matter. Summarize them; don't paste the transcripts back.
- "What did that subagent find?": `ws-runs list --parent` (children of the current run), or use the
  runId the delegate result gave you, then `ws-runs show <runId>`.
- "When did we talk about X?": `ws-runs search "X"`, then `show` the run it names.
- Debugging your own failed or aborted run: `ws-runs list` shows its status; `ws-runs show <runId> --full`
  shows the exact tool calls and errors.

Output is redacted (tokens, keys and long secret-looking blobs become `[REDACTED]`). If a redaction
hides something you need, ask drk; don't try to recover it another way.
