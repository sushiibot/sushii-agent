---
name: session-history
description: Look up your own past runs and conversations in ~/history with rg and cat (ws-runs only for raw tool output). Use for recall beyond the current conversation, including past preferences, facts and decisions, or when asked what you did earlier ("what did I do yesterday", "what did we decide about X last week"), what a subagent or scheduled job found, or when debugging one of your own past runs.
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

## Recall from source transcripts

When an answer depends on an earlier conversation, search before answering from a recap or memory.
Recaps help locate evidence; the transcript establishes what was actually said.

1. Search names, exact phrases and topic synonyms. Use bounded matches with line numbers:
   `rg -n -i -F -e "topic" -e "other wording" ~/history`.
2. Read the matching exchange and its surrounding messages:
   `sed -n '40,100p' ~/history/YYYY-MM/DD-<runId>.md`.
   Check whether a statement came from the user, the agent, or a tool.
3. If the question concerns a current preference or decision, search for later corrections.
   Give the most recent explicit decision, and explain any unresolved conflict.
4. Answer with the relevant date and source file or run ID. Distinguish a direct record from an inference.
   If the search finds no evidence, say what you searched; do not invent a recollection.

Keep large histories outside the prompt. Read relevant slices instead of printing the entire directory.
A failed keyword search does not prove absence. Try related wording and daily recaps to find candidates.
For questions spanning many days, split the search by date or topic. Delegate bounded reading tasks
when useful, asking each reader for source paths, dates and supporting exchanges. Combine the evidence,
check disputed claims against their transcripts, and stop when the question is answered.

This workflow adapts the external-context idea from
[Recursive Language Models](https://arxiv.org/abs/2512.24601): inspect long records programmatically,
then reason over selected pieces. It uses the existing filesystem and delegation tools. It is not
an implementation of the paper's recursive REPL runtime, and has no measured recall improvement yet.

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
