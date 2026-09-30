# tasks/

One file per project, `tasks/<slug>.md`, read on demand (only `~/TASKS.md` is loaded into context).

Start each file with:

```
# <project name>
status: active        (active | done | dropped)
updated: YYYY-MM-DD   (bump it whenever you touch the project)
```

Then the goal, the plan, a sub-task checklist (`- [ ]` / `- [x]` / `- [-]`; add `updated:YYYY-MM-DD`
when you tick one), decisions, links (repos, PRs, `run:<runId>`) and notes.

Done and dropped projects move to `tasks/archive/`; the nightly upkeep does it once `status:` says so.
