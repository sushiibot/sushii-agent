---
name: session-history
description: Look up your own past runs and conversations in ~/history with rg and cat (ws-runs only for raw tool output). Use when asked what you did earlier ("what did I do yesterday", "what did we decide about X last week"), what a subagent or scheduled job found, or when debugging one of your own past runs.
---

# Session history

Every run you do (each chat turn, subagent and scheduled job) is written to `~/history` as plain
markdown when it ends. Read it with `rg`, `cat`, `ls` and `find` like any other file. It is not
versioned and only the workspace writes it, so don't edit it.

## Layout

```
~/history/
  2026-09-29.md          the day: one line per run, then that day's session summaries
  2026-09/29-<runId>.md  one run: header, then the transcript
```

- The daily file (`YYYY-MM-DD.md`, in the workspace time zone) is the high-level view. It has two
  sections:
  - `## Runs`: one line per run with its time, kind (`chat`, `flush` for a memory flush, `subagent/<name>`, `job/<name>`), a
    topic from the first message, the tool count, the status and a link to the run file.
  - `## Sessions`: the recap of each chat session that ended that day (idle rotation or `!new`) and
    each compaction summary. The heading has the time, the reason, a one-line topic and the session
    file name.
- The run file is the detail. The header has the time, agent, origin (e.g. `discord:<messageId>`),
  model, tokens, status, and links to the parent run and any subagent runs. Then the transcript:
  user messages and your replies in full, and one line per tool call with its arguments cut to
  about 120 characters and an `ok`/`error` hint. It has no raw tool output.

## How to use it

- "What did I do yesterday?": `cat ~/history/<yesterday>.md`, then open the run files that matter.
  Summarize them; don't paste the transcripts back.
- "When did we talk about X?": `rg -il "X" ~/history`, then read the daily line or run file it
  names. `rg "X" ~/history/*.md` searches only the daily files (run topics and session recaps).
- "What did we decide about X?": search the `## Sessions` recaps first
  (`rg -A20 "X" ~/history/*.md`). Their Decisions sections are the condensed record.
- "What did that subagent find?": open the parent run's file and follow its `Subagent:` link, or
  use the runId the delegate result gave you: `ls ~/history/*/*-<runId>.md`.

## ws-runs: raw output and run trees

The history files leave out tool output. Use `ws-runs` only when you need that output, or a run
tree the files don't show:

```sh
ws-runs show <runId> --full   # complete tool calls and results, e.g. to debug a failed run
ws-runs list [--limit N] [--agent NAME] [--parent [RUNID]] [--since ISO]
ws-runs search <text> [--limit N]
```

Your current run's id is in `$WS_RUN_ID`, and a bare `--parent` lists the current run's children.
The Pi session files themselves sit in the agent dir, which the secret guard blocks, so don't try
to open them directly.

History and `ws-runs` output are redacted (tokens, keys and long secret-looking blobs become
`[REDACTED]`). If a redaction hides something you need, ask drk; don't try to recover it another way.
