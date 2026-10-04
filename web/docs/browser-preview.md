# Browser preview

Main and topic chats show a live preview when their agent uses the local browser.
The preview appears below the voice call bar, above the conversation.
Exa searches and page-text requests do not create a browser preview.

## Viewing

The first frame opens the preview automatically.
Hide stops frame delivery and leaves a Show button.
This choice remains in effect for the same browser task, including navigation and reconnection.
Another task opens its own preview.

Expand opens a full-screen viewer with fit, zoom, and address details.
Android Back and Escape close the viewer.
The viewer accepts no mouse, keyboard, or touch input for browser control.
Reconnection preserves the last frame and labels it clearly.

On completion, the inline preview shows Finished for five seconds, then removes its image.
An expanded viewer retains its last frame until the owner closes it.
Frames remain in memory. The server does not save screenshots or browser addresses for this feature.

## Browser lifecycle

The `browser` tool runs `agent-browser` arguments in a dedicated session.
For example, `{"args":["open","https://example.com"]}` opens a page.
Managed Bash commands use the same session through `AGENT_BROWSER_SESSION`.
Session overrides and commands that close all browsers are refused.
Writer subagents also receive managed sessions.

The workspace closes each session when its owning run settles or its agent session ends.
This includes completion, failure, cancellation, reset, and shutdown.
A registry records owned session names before launch. Startup closes sessions left in that registry.
A watchdog retries failed cleanup and closes abandoned sessions.
Active runs retain their browser during owner approvals.
The workspace does not close a personal browser that it did not launch.

Closing the viewer does not close the browser.
Leaving chat or ending a voice call also does not stop browser work.
Configured browser restore state remains separate from the browser process.

## Transport

Chromium uses a 1280 × 800 viewport.
The stream uses JPEG quality 60, with a 1280 × 800 frame limit.
The inline viewer requests up to five frames per second. The expanded viewer requests up to fifteen.
Actual delivery depends on page changes and network latency.

The browser stream stays on workspace loopback.
The bot requests the latest frame through the existing authenticated workspace RPC connection.
The owner gateway sends frames through `/api/browser/connect` and checks the browser Origin.
Clients acknowledge displayed frames. The relay keeps at most one frame in flight for each viewer.
The relay accepts acknowledgements and heartbeat messages only.
Hidden pages disconnect their viewer. Workspace streams expire after two seconds without viewer requests.

The standalone Browser screen remains a development preview for future interactive takeover.

## Verification

Backend tests cover ownership, cleanup, recovery, isolation, and viewer authentication.
Web tests cover hide, show, navigation, reconnection, completion, zoom, Back, accessibility, and responsive layout.
`scripts/browser-preview-smoke.ts` checks real Chromium frames and cleanup in both shipping images.
The optional system flow checks the complete bot, workspace, proxy, and browser path.

For that flow, install `agent-browser` and run:

```sh
E2E_BROWSER_EXECUTABLE_PATH=/path/to/chrome bun run e2e:system browser-preview
```

The CLI must resolve directly from `PATH`, including when the test workspace uses a temporary home directory.
