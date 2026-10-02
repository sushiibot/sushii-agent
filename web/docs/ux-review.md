# UI and UX review

Reviewed on October 2, 2026 against [UX guidelines](ux-guidelines.md).
The review covers live search, History, Memory, settings, and MCP connection flows.
It combines source review with browser regression checks. It does not replace testing on the installed phone app.

## Addressed in this pass

| Finding                                                                    | Change                                                                               | Verification                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Search labels disappear during entry; clearing depends on browser controls | Shared `SearchField` keeps a visible label and a 48px clear button                   | Search reset, keyboard focus, and reflow checks              |
| Memory search appears to work on Changes but ignores it                    | Search filters files and recorded changes, including source titles                   | Older matching changes, case, whitespace, and reset checks   |
| A Memory search with no matches says nothing exists                        | Separate no-match and empty-collection states, with clear search                     | Memory empty and filtered states                             |
| Returning to History hides cached days and discards older pages            | Keep cached rows and the pagination cursor; refresh errors offer retry below content | Store pagination and failed-refresh browser checks           |
| A capped search with no hits claims a definitive absence                   | Explain that only part of the record was searched                                    | Truncated zero-hit response                                  |
| MCP reconnect shows tracking-snapshot progress and errors                  | Scope progress and failure messages to the actual operation                          | Delayed reconnect and contextual failure checks              |
| Secondary MCP buttons crowd the connection details                         | One header action menu; visible status; tracking controls remain under Tools         | Action reachability, Escape, reflow, and stable pager checks |
| Copying an OAuth link can fail silently                                    | Show a copy error and explain manual selection                                       | Clipboard rejection                                          |
| Connection validation lacks field associations                             | Associate helper text and local validation with the relevant input                   | Invalid URL and callback descriptions                        |

## Remaining findings

- **Add-server progress resets after navigation.** Returning to the Add route starts the flow again. Preserve non-secret progress in memory, or offer an explicit discard guard. Never persist tokens or callback codes as ordinary form drafts.
- **Cached detail refresh failures still replace the detail view.** Run, History-day, and MCP details retain content during loading, but their shared fallback replaces it after a failure. Extend the shared screen state to keep usable cached content and offer an inline retry.

Treat these as implementation gaps. The guidelines describe the intended behavior; they do not claim these gaps are resolved.

## Validation

- Svelte checks pass with no errors or warnings. Lint and 330 unit tests pass.
- The full browser suite passed 414 checks before the final action-menu revision.
- The final menu and shared pager pass 37 focused browser checks.
- Five real bot system checks cover Runs, History, and Memory.
- Visual review covers 320px, 412px, and desktop dark layouts, including the open menu and filtered empty state.
