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

## Follow-up fixes

- **Add-server progress survives navigation.** The URL and sign-in step stay in memory for the app visit. Tokens and callback addresses clear on leaving. A visible restored-progress notice explains this and offers Start over. Successful connections clear the flow.
- **Cached detail survives refresh failure.** `TabbedScreen` keeps the pager and expanded content mounted. An error and retry appear below the current panel's content. First-load failures and missing records keep their existing states.
- **Drawer selection does not expose the previous screen.** The drawer remains open during route loading. The shared shell dismisses it after the committed route renders, including changes within the same navigation section.

These fixes address the two findings left open by the initial pass and the reported navigation flash.

## Validation

- Svelte checks pass with no errors or warnings. Lint and 330 unit tests pass.
- The full browser run passed 420 checks. One new navigation assertion incorrectly queried a hidden dialog.
- After correcting that assertion and current-page dismissal, all 19 navigation and drawer checks pass.
- Add-server resume and cached detail refresh regressions passed in the full run.
- Five real bot system checks cover Runs, History, and Memory.
- Visual review covers 320px, 412px, and desktop dark layouts, including the open menu and filtered empty state.
