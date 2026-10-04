# UX guidelines

Rules for every screen in the personal agent web app. The bar: better than the Discord DM it replaces, judged on a real Android phone, one-handed, not in a desktop browser.

Every rule has a one-line why and a check. A rule without a check is a wish, so review goes rule by rule and asks "did the check pass?"

The clickable prototype (`src/proto-routes/proto`, which renders the shipped feature screens from `src/lib/features` on their fixtures) sets the design direction. Where the prototype breaks a rule below, the rule wins; see [Known gaps](#known-gaps-in-the-prototype).

## Check key

| Tag      | Meaning                                                                                |
| -------- | -------------------------------------------------------------------------------------- |
| `axe`    | `@axe-core/playwright` scan, see [Accessibility](#accessibility)                       |
| `pw`     | Playwright assertion at 412x915 (and 320 wide where noted)                             |
| `shot`   | A screenshot in the [state matrix](#state-matrix), reviewed by eye against these rules |
| `phone`  | Manual step on the real phone, installed PWA, not a browser tab                        |
| `check`  | `bun run check` (svelte-check, compiler a11y warnings)                                 |
| `review` | Code review reads the diff for it; no tool catches it                                  |

## Mobile: Android first

The primary device is an Android phone running the installed PWA (Chrome WebAPK, `display: standalone`). Desktop is a wider layout of the same app, not a separate design.

### Reach and touch targets

- **Every tappable element is at least 48x48 CSS px, including padding.** Why: Android and Material specify 48dp as the minimum for reliable touch ([Android API defaults](https://developer.android.com/develop/ui/compose/accessibility/api-defaults), [Android accessibility help](https://support.google.com/accessibility/android/answer/7101858)); 1 CSS px = 1dp on Android Chrome. Check: `pw` bounding-box assertion (below). axe does NOT cover this: its `target-size` rule tests the WCAG 2.5.8 floor of 24px (`minSize: 24` in axe-core 4.13).
- **Use the `Button` `default` or `lg` size (`h-12`, 48px) for primary actions and icon buttons.** Why: the stock shadcn sizes (32 and 36px) are below the minimum; the app's `Button` overrides them. Check: `pw`.
- **Adjacent targets have at least 8px between their hit areas.** Why: Material spacing guidance; mis-taps on approve/deny rows are costly. Check: `shot`, `pw`.
- **Inline text links inside prose are exempt from the 48px rule, but nothing important is reachable only through one.** Why: WCAG 2.5.8 exempts inline links because they are small and easy to miss. Check: `review`.
- **Primary actions sit in the bottom third of the screen: composer, approve/deny, the main button of a sheet.** Why: about half of observed phone grips are one-handed, and the top corners are the hardest reach for that thumb ([Hoober, How do users really hold mobile devices](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)). Check: `shot` at 412x915; the primary action's top edge is below y=610.
- **The top bar holds title, back and secondary actions only. The general chat is titled Sushii, with no static subtitle; activity belongs beside the conversation.** Why: nothing there should need reaching for mid-task. Check: `review`.
- **Destructive or outward actions (Deny, Delete, Send now) are never the largest target and never sit where a mis-tap from the primary lands.** Why: Fitts's law works against you for dangerous actions. Check: `shot`.
- **Section swipes follow the visible tab order and stop at each end.** On touch screens, Runs filters, run details, History days, Memory and MCP details support left/right swipes in the content area. Vertical scrolling, text controls, selection and horizontal code/table scrolling keep their normal behavior. The left edge stays available to the drawer and the outer edges stay available to system navigation. Panels follow the finger continuously and snap on release; tapping a tab animates the same pager. The underline tracks the panel position. Keep headers fixed and preserve each panel’s scroll and expanded content. Tabs remain the tap and keyboard alternatives. Check: `pw` (`e2e/tab-swipe.test.ts`).
- **No gesture-only actions. Every swipe or long-press has a visible button alternative.** Why: WCAG 2.5.7 Dragging Movements; gestures are undiscoverable. Check: `review`.
  - Per-message actions are visible icon buttons in a row under the message (Copy, and Share where the browser has `navigator.share`), never a gesture or a hijacked menu: the app does not intercept `contextmenu`, long-press or middle-click, so the browser's own menu, text selection and autoscroll work in the chat. The row is always shown under the newest reply and on touch screens; on hover-capable devices older rows are transparent until hover or `:focus-within`, keeping their height so nothing moves. Icons are 16px inside 48px buttons, each with an `aria-label` and a `title`. The row never holds anything approval-like. Check: `pw` (`e2e/message-actions.test.ts`).

```ts
// 48px target assertion; run on every screen in the state matrix.
const small = await page.$$eval(
	'a, button, [role=button], input, textarea, [role=tab], summary',
	(els) =>
		els
			.filter((e) => !(e.tagName === 'A' && e.closest('p'))) // inline prose links are exempt
			.map((e) => ({ e, r: e.getBoundingClientRect() }))
			.filter(({ r }) => r.width > 0 && (r.width < 48 || r.height < 48))
			.map(({ e }) => e.outerHTML.slice(0, 80))
);
expect(small).toEqual([]);
```

### Viewport, keyboard and system bars

- **`app.html` uses exactly this viewport meta:**

  ```html
  <meta
  	name="viewport"
  	content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
  />
  ```

  Why: since Chrome 108 the keyboard resizes only the visual viewport by default; `resizes-content` restores resizing the layout, so a flex column keeps the composer above the keyboard with no script ([Chrome: viewport resize behavior](https://developer.chrome.com/blog/viewport-resize-behavior)). `viewport-fit=cover` opts into edge-to-edge drawing so the app, not Chrome, owns the gesture-bar area ([Chrome edge-to-edge guide](https://developer.chrome.com/docs/css-ui/edge-to-edge)). Check: `review` of `app.html`.

- **The keyboard never covers the composer or the focused field.** Why: the most common "this app is broken" moment on phones; also WCAG 2.4.11 Focus Not Obscured. Check: `phone`: open a chat, tap the composer, type three lines; the composer and its send button stay fully visible.
- **Keep the `--kb` visualViewport fallback for iOS, where `interactive-widget` has not shipped.** Why: iOS overlays the keyboard; the layout does not resize. Check: `review` (the shell and sheets read `--kb`, defined in `app.css`).
- **The app root uses `100dvh` or `inset: 0`, never `100vh`.** Why: `100vh` ignores the dynamic browser UI and the keyboard. Check: `rg -n -g '!src/proto-routes/**' '100vh|h-screen' src` returns nothing (`h-screen`, `min-h-screen` and `max-h-screen` compile to `100vh`).
- **Anything pinned to the top or bottom pads with `env(safe-area-inset-*)`: the header and the drawer add `--safe-top`, the composer and the drawer add `--safe-bottom`.** Why: edge-to-edge content otherwise sits under the status bar and the gesture bar. Check: `phone` with gesture navigation on; nothing tappable overlaps the gesture pill.
- **Text inputs use a font size of at least 16px.** Why: iOS zooms the page on focus below 16px; the same size reads well on Android. Check: `pw` computed style on `textarea, input`.
- **`theme-color` matches `--background` in both themes, via two `<meta name="theme-color" media="(prefers-color-scheme: ...)">` tags or a script that follows the theme toggle.** Why: a white status bar over a dark app looks broken. Check: `phone` in light and dark.
- **`overscroll-behavior: none` on the document, `contain` on scroll regions.** Why: stops pull-to-refresh from reloading the app mid-chat and stops scroll chaining into the page. Check: `phone`: pull down at the top of a chat; the app does not reload.

### Back gesture and navigation

In a standalone PWA there is no browser back button: the Android back gesture is the only back control. It must do what the user expects on every screen.

- **Back closes the topmost overlay first (sheet, dialog, menu), and only then leaves the screen.** Why: Android sends a close request that native `<dialog>` and `popover` handle for free; a `div role="dialog"` ignores it and back navigates away instead ([MDN CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher)). This applies to the shadcn-svelte Dialog and Sheet too: bits-ui renders them as `div`s, so each needs the history-entry wrapper or a verified close on the phone. Build overlays on `<dialog>`/`popover`, or have them push a history entry and close on `popstate`. Check: `phone`: open every sheet and press back; the sheet closes and the screen stays.
- **Drawer navigation reveals the destination, not the previous page.** Keep the drawer open while a selected route loads. Close it after the destination renders. Choosing the current destination can close it immediately. Check: `pw`: delay the destination's route chunk; the drawer stays open and closes over the new header.
- **Sheet dismissal finishes before a following route change.** Phone sheets slide out fully and fade; desktop dialogs fade with a small scale change. Content and scrim use the same duration. Reduced motion disables both animations. Check: `pw` (`e2e/sheet-motion.test.ts`).
- **Every pushed screen (chat, run detail, memory diff) is a real URL navigated with `goto`, never `replaceState` or in-component state.** Why: with one history entry, back exits the app. Check: `phone`: Home → chat → run detail, then back twice lands on Home.
- **Back closes the drawer first; back from a drawer destination returns to the chat; back from the chat exits.** Why: the Android convention for drawer apps, and the chat is where the app opens. Picking a destination from the drawer replaces the entry unless it is left from the chat. Check: `pw` (`e2e/nav.test.ts`), `phone`.
- **A dirty composer or edit survives back and return.** Why: a mis-swipe must not cost a typed message. Keep the draft per chat in memory, and in `sessionStorage` for reloads. Check: `phone`: type, swipe back, reopen the chat; the text is there.
- **No `target="_blank"` for in-app routes.** Why: it opens a Custom Tab and breaks back. Check: `review`.
- **The app opens on the chat. Top-level destinations (Chat, Inbox, Threads, Runs, History, ..., Settings) live in a drawer opened from the header's menu button on phones and in the sidebar on desktop; detail screens show a back chevron instead.** Why: the chat keeps the full height (no tab bar under the composer), and one navigation system per screen. The drawer is a native modal `<dialog>`, so Android back and Escape close it. The menu button carries a dot when the inbox has something waiting or unread. Check: `shot`, `pw` (`e2e/nav.test.ts`).

## Interaction and information hierarchy

These rules guide new screens and changes to existing screens. They describe the required behavior, not completed implementation.

- **Start with the user's next decision.** Why: a screen becomes easier to scan when its content supports one task. Check: `review`: name the task and the main action before choosing the layout.
- **Reuse familiar controls and shared components.** Why: repeated patterns reduce relearning and prevent layout drift. Check: `review`: inspect existing `ui/` components and feature patterns before creating a new variant.
- **Group secondary actions in one predictable menu.** Reuse `ui/menu/ActionMenu` for compact header commands. Why: several equally prominent actions compete with the main task. Check: `shot`, `phone`: related thread actions share one overflow menu, and the main action remains visible.
- **Use links for navigation and buttons for actions.** Why: browser behavior and accessible semantics depend on this distinction. Check: `review`, `check`: navigation rows use anchors; actions use buttons; interactive controls never nest inside anchors.
- **Keep decision-changing information visible.** Why: users cannot act on a consequence hidden behind a disclosure. Check: `review`: permissions, action scope, and failure status remain visible before the relevant action.
- **Disclose reference detail where it helps.** Why: long explanations crowd the task. Check: `shot`, `phone`: inline details use a disclosure; mid-task reading uses a sheet that returns to the same position.
- **Name disclosures by their contents.** Why: labels such as “More info” do not explain why someone would open them. Check: `review`: the label names the topic, and expanded content adds detail instead of repeating visible copy.
- **Reuse explanatory content across presentations.** Why: separate copies of the same help text drift. Check: `review`: a disclosure and sheet that explain the same concept render shared content.

## Lists, filters, and data views

Apply these rules to Runs, History, Memory, connections, and future data screens.

- **Keep row anatomy consistent.** Why: the same object must remain recognizable across lists and lifecycle states. Check: `shot`: title, summary, status, and metadata keep their relative positions across views.
- **Put consequential decisions in their full context.** Why: a summary row can omit the information needed for a safe decision. Check: `review`: approval opens the exact action and evidence before the decision controls.
- **Keep status transitions traceable.** Why: an item that disappears after an action can look lost. Check: `pw`: an updated item remains reachable through its detail URL or an explicit completed/history view.
- **Show the active scope.** Why: an unexplained filter can look like missing data. Check: `shot`, `pw`: the selected tab or filter is visible, and users can clear filters without reloading.
- **Separate empty results from empty collections.** Why: “No runs yet” gives the wrong explanation when a filter excludes existing runs. Check: `pw`: no-match states offer clear/reset; empty collections explain what will appear and the next useful action.
- **Choose a useful default order.** Why: insertion order rarely matches the next decision. Check: `review`: queues prioritize attention; history prioritizes recency; the current sort is understandable.
- **Adapt dense data to phones.** Why: a wide desktop table can hide the fields needed for the task. Check: `shot` at 320px and 412px: rows become stacked summaries where appropriate, with secondary fields in detail.
- **Align comparable numbers.** Why: stable columns make differences easier to scan. Check: `shot`: numeric columns align right and use tabular numerals; text aligns left.
- **Add table machinery only for a concrete need.** Why: sorting a small loaded list does not require a new abstraction or dependency. Check: `review`: pagination, virtualization, or column management justifies extra table infrastructure.
- **Make bulk scope explicit when bulk actions exist.** Why: selection can extend beyond the visible page. Check: `pw`, `shot`: visible checkboxes and an affected-item count distinguish current-page selection from all matching items.

## Forms, edits, and recovery

- **Use persistent labels and field-level errors.** Why: placeholders disappear during entry, and a generic error leaves users guessing. Check: `axe`, `pw`: labels remain visible; errors associate with the relevant fields; values survive failed saves.
- **Accept harmless input variation.** Why: whitespace or common formatting must not create unnecessary work. Check: `pw`: supported input formats normalize consistently, without changing a meaningful URL, token, or identifier.
- **Use the control that matches the choice.** Why: actions, settings, and fixed options have different expectations. Check: `review`: menus contain actions; selects contain mutually exclusive options; switches represent immediate on/off settings.
- **Confirm the actual save result.** Why: an optimistic update is not proof that the server accepted it. Check: `pw`: saving, saved, and failed states remain distinct; failed edits retain values and offer retry.
- **Protect substantial unsaved work.** Why: accidental back or dismissal must not silently discard an edit. Check: `pw`, `phone`: dirty forms preserve their draft or explain discard; clean forms close without a warning.
- **Scope restored drafts to the record.** Why: an edit for one item must never appear in another. Check: `pw`: draft keys include the route and record identity; successful saves clear the draft.
- **Make restored form drafts explicit.** Why: stale values can overwrite a fresh edit unnoticed. Check: `shot`, `pw`: restoration has a visible discard action and an expiry appropriate to the task. Chat drafts follow the chat-specific rule above.
- **Choose draft storage deliberately.** Why: persistent storage can expose secrets or sensitive content on a shared device. Check: `review`: persistence, retained fields, expiry, and clearing behavior are documented; credentials never enter form draft storage.
- **Match confirmation to the consequence.** Why: routine confirmation trains reflexive acceptance. Check: `review`: reversible local edits favor recovery or undo; consequential actions explain the exact effect before commitment.
- **Keep delayed external effects honest.** Why: a queued action is not complete, and undo must remain available while cancellation is possible. Check: `pw`: any grace period appears on the item, survives navigation, and states when undo ends.

## Chat and agent

### Sending

- **A sent message renders in the list within one frame of tapping Send, before any network call.** Why: waiting for the server makes the app feel broken on mobile networks (optimistic UI; Doherty threshold). Check: `pw`: tap Send with the network throttled to 3G; the bubble is visible within 100ms.
- **Every user message shows its delivery state in text or icon plus an accessible label: Sending → Sent → (optional) Seen by agent; or Failed with Retry.** Why: "did it go?" is the question a Discord DM never answers well. Check: `shot` of each state; `axe` for the labels.
- **Failed sends stay in place with Retry and Delete, keep their text, and never vanish.** Why: silent loss is the worst chat bug. Check: `pw`: fail the POST; the bubble shows Failed and Retry resends the same client id.
- **Messages carry a client-generated id so a retry or a reconnect never duplicates them.** Why: retries after a timeout are the usual source of doubles. Check: `review` of the send path.
- **Sends while offline queue locally and show "Queued, sends when you're back online".** Why: the phone drops off the tailnet often. Check: `pw` with `context.setOffline(true)`.
- **The composer grows up to about 6 lines, then scrolls inside itself. Enter inserts a newline on touch devices; the Send button sends.** Why: a mobile keyboard's Enter is not a send intent. Check: `phone`.

### Streaming and scroll

- **The chat opens at the newest message, with no visible scroll animation.** Why: the newest message is why you opened it. Check: `pw`: after load, the distance from the bottom (`scrollHeight - clientHeight - |scrollTop|`, which holds for both normal and `flex-col-reverse` containers) is ≤ 1px.
- **Stick to the bottom only when the reader is already within 48px of it.** Why: auto-scrolling while someone reads older messages yanks the text away. Check: `pw` (below).
- **When the reader is scrolled up and new content arrives, show a "New messages" pill above the composer; tapping it scrolls to the newest message.** Why: the reader learns something arrived without losing their place. Check: `pw` (below), `shot`.
- **Streaming never shifts the text the reader is looking at.** Why: layout shift while reading is the main jank complaint in chat UIs. Use `overflow-anchor` or the column-reverse container, and reserve height for a message before its content lands. Check: `pw` (below).
- **Batch streamed tokens to at most one DOM update per animation frame.** Why: per-token updates drop frames on mid-range phones. Check: `review`; `phone` with a long streaming reply stays smooth.
- **Do not put streaming text in an `aria-live` region token by token. Announce "Agent replied" once the message completes.** Why: per-token announcements make a screen reader unusable. Check: `review`.

```ts
// Scroll-jank test: reader scrolled up, new content arrives, nothing moves.
// Scroll by delta: in a flex-col-reverse container scrollTop is 0 at the bottom and negative above it.
await list.hover();
await page.mouse.wheel(0, -600);
const fromBottom = () =>
	list.evaluate((el) => el.scrollHeight - el.clientHeight - Math.abs(el.scrollTop));
expect(await fromBottom()).toBeGreaterThan(48); // precondition: the reader really left the bottom
const topVisible = () =>
	list.evaluate((el) => {
		const box = el.getBoundingClientRect();
		const msg = [...el.querySelectorAll('[data-message-id]')].find(
			(m) => m.getBoundingClientRect().bottom > box.top
		)!;
		return { id: msg.getAttribute('data-message-id'), top: msg.getBoundingClientRect().top };
	});
const before = await topVisible();
await pushStreamChunks(page, 20); // fixture helper: append a message and stream into it
const anchor = list.locator(`[data-message-id="${before.id}"]`);
const after = await anchor.evaluate((e) => e.getBoundingClientRect().top);
expect(Math.abs(after - before.top)).toBeLessThanOrEqual(1);
await expect(page.getByRole('button', { name: /new messages/i })).toBeVisible();
```

### Live voice

- **Keep the call button in the top-right header.** After connection, close setup and show a compact call bar below the header. Keep mute, captions, and End call visible. Implementation: `VoiceControl` and `VoiceCallBar`. Check: `pw`, `shot` at 320px and desktop widths.
- **Keep chat, tool activity, and approvals visible during calls.** Show microphone and playback state separately from background agent work. Opening settings must keep the call running. Check: `pw` with a working agent and an open call.
- **Show provider captions in the existing chat message layout as text arrives. Use muted italic text until finalized, and keep an icon with “Voice” below spoken messages after finalization.** Replace revised snapshots and final corrections without duplicate words. Provider timing may delay text until a pause. Hide the empty-thread greeting once voice text arrives. Keep token updates out of live announcements. Implementation: shared `MessageText`, `VoiceCaptions`, and the provider adapters. Check: protocol tests and `pw` with revisions and delayed final text.

### Tool activity

- **The agent shows a compact typing indicator within 300ms of receiving a message, until text or activity arrives.** Why: silence reads as a missed message, while an oversized status block wastes space. Check: `pw` with delayed replies.
- **Tool calls appear individually in chronological order between assistant text.** Each compact row names the action in plain words and shows its status; do not merge every call into one block above the reply. Why: the user can follow the work where it happened. Check: `pw`, `shot` with interleaved text and 5+ calls.
- **Each tool row expands to exact input and output on demand.** Keep raw JSON and long results out of the default transcript. A failed action remains visibly failed while collapsed. Check: `phone`, `shot`.
- **Completed tools remain compact in history and preserve the same ordering after reload.** Why: streaming and restored history should describe the same conversation. Check: `pw` after reload.
- **Delegated work stays visible in the originating conversation.** Show a compact task card with agent, repository, status, and latest activity; keep a background-work strip above the composer while agents run. Tap for activity, results, or agent-specific Stop. Inbox is a secondary notification surface. Why: work should be findable where the user started it. Check: `pw` after the parent reply and reload.

### Approval cards

- **Pending approvals attach directly to their tool call, using the same component in prototypes and live chat.** Show a readable action title and structured details appropriate to the action, with exact raw arguments under “Exact input.” Long bodies expand on demand. Why: the user needs clarity without a large debug dump or duplicated card. Check: `review`, `shot` on mobile and desktop.
- **Approve and Deny name the decision clearly.** Editing appears only when the action supports editing; do not imply it exists for every tool. Why: controls must match the action available. Check: `review` against API behavior.
- **While submitting, disable decision controls and show “Submitting…” until server confirmation.** Do not dismiss the request optimistically. On failure, retain the request and show the error. Check: `pw` with delayed and rejected decisions.
- **Once answered, replace the approval prompt with a quiet decision status in the tool's expandable details.** Retain the decision for inspection, but remove the attention card and controls. Denied, expired, and cancelled requests also cease to appear actionable. Why: an answered request should not look pending. Check: `pw` after answering and reload.
- **Approval status is separate from execution status.** Approved does not imply Running, Completed, or successful execution. Check: `pw` for approval followed by execution failure.
- **Durable allow rules are separate, off-by-default controls that explain exactly which future actions they cover.** Tainted runs explain why approval was requested despite an allow rule. Check: `review`.
- **Every pending approval appears in Inbox and in the tab badge, with a link to its originating conversation.** Why: the user can find a buried request without making Inbox the only place it is visible. Check: `pw`.

### Outcomes: finished is not succeeded

- **A run ends as `verified` or `unverified`, never a plain green "Done".** Why: vendors' own docs say a completed run doesn't confirm the result ([Claude routines](https://code.claude.com/docs/en/routines), [Dots](https://learn.chatgpt.com/docs/dots)). Use the `status.ts` keys. Check: `review`, `shot`.
- **`verified` lists its evidence: message-id, readback, HTTP status, file, screenshot (`Evidence.kind`).** Why: evidence is what makes a result trustworthy. Check: `shot` of run detail.
- **`unverified` says what was not checked, in one line.** Why: it tells the user what to check themselves. Check: `shot`.
- **Quiet scheduled runs say why they were quiet: `quiet`, `suppressed`, `skipped`, `outside-hours`, or `failed`.** Why: "nothing happened" and "it broke" look the same without it. Check: `shot` of Schedules.
- **Failures file under "Waiting on you", not under "Done".** Why: a failure needs a decision. Check: `pw` on Home grouping.

### Long content on narrow screens

- **No horizontal page scroll at 320px, whatever the content.** Why: WCAG 1.4.10 Reflow. Check: `pw` reflow assertion at 320 and 412.
- **Code blocks scroll horizontally inside their own box, keep a Copy button (48px) in view, and never wrap code silently.** Why: wrapped code is wrong code; page-level overflow breaks the layout. Check: `shot` with a 200-column line.
- **Long URLs, paths, message-ids and hashes use `break-all` or `overflow-wrap: anywhere`.** Why: one long token otherwise widens the page. Check: `pw` reflow with the long-content fixture.
- **Tables in replies scroll inside a wrapper, with the first column sticky if it's wider than the screen.** Why: tables can't reflow. Check: `shot`.
- **Messages over about 40 lines collapse with "Show all (N lines)".** Why: one giant reply shouldn't push the conversation off-screen. Check: `shot`.
- **Diffs use `--add`/`--del` backgrounds plus a `+`/`−` gutter, not color alone.** Why: WCAG 1.4.1 Use of Color. Check: `shot` in dark.

### Never-silent states

Blocking waits and required actions need visible feedback. Cached background refreshes can remain quiet. A spinner alone does not explain a wait.

| State            | What the user sees                                                           | Check         |
| ---------------- | ---------------------------------------------------------------------------- | ------------- |
| Offline          | Top banner "Offline. Messages send when you reconnect."                      | `pw` offline  |
| Reconnecting     | "Reconnecting…" with elapsed time after 5s; resumes on its own               | `pw`, `phone` |
| Reconnected      | Banner clears; missed messages load in place, no duplicate bubbles           | `pw`          |
| Queued send      | Bubble marked "Queued"                                                       | `pw`          |
| Failed send      | Bubble marked "Failed" with Retry                                            | `pw`          |
| Agent working    | "Working" row with the current step                                          | `shot`        |
| Waiting on you   | Card in chat, item in Inbox, badge on the drawer button                      | `shot`        |
| Agent error      | Inline error naming the layer that failed (model, tool, connection)          | `shot`        |
| Loading a screen | Delayed layout-matched placeholders on first load; cached content on refresh | `shot`        |
| Empty            | What will appear here, plus one next action                                  | `shot`        |
| Update available | "Update ready · Reload"; never reloads on its own mid-typing                 | `phone`       |

- **Reconnection is automatic with backoff, and never asks the user to reload.** Why: the tailnet drops whenever the phone changes network. Check: `phone`: toggle airplane mode for 20s mid-stream; the reply finishes after reconnect.
- **Error text names what failed and what to do ("Model provider timed out. Retry."), never a status code alone.** Why: Hermes's layer-named error cards are the good example. Check: `review`.

## Perceived-performance budgets

Measured on the real phone (mid-range Android), installed PWA, on the tailnet. Budgets are for the 75th percentile of dogfood sessions, matching how web.dev sets its thresholds.

| Moment                                            | Budget        | Basis                                                                                                          | Check                    |
| ------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Cold open to app shell painted                    | ≤ 1.0s        | Shell is precached by the service worker                                                                       | `phone`, Performance tab |
| Cold open to newest messages visible              | ≤ 2.5s        | LCP "good" is ≤ 2.5s ([web.dev LCP](https://web.dev/articles/lcp))                                             | `phone`                  |
| Tap Send to own bubble visible                    | ≤ 100ms       | Optimistic render, no network                                                                                  | `pw`                     |
| Message received to "Working" visible             | ≤ 300ms       | Past this, silence reads as failure                                                                            | `pw`                     |
| First token received to first token painted       | ≤ 1 frame     | The UI adds no buffering of its own                                                                            | `review`                 |
| No token 2s after "Working"                       | Show the step | "Thinking…" or the current tool, never a bare spinner                                                          | `shot`                   |
| Any interaction (tap, toggle, tab switch)         | INP ≤ 200ms   | INP "good" is ≤ 200ms ([web.dev INP](https://web.dev/articles/inp))                                            | `phone`, `pw` trace      |
| Micro-interaction animation (press, toggle, pill) | 100–200ms     | M3 short2–short4 ([M3 duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)) | `review`                 |
| Sheet, dialog, screen transition                  | 250–300ms     | M3 medium1–medium2                                                                                             | `review`                 |
| Any animation                                     | never > 400ms | Longer animations block a user who already knows where they're going                                           | `review`                 |

## Notifications

The push payload is `{ title, body, url, tag? }`; the service worker shows it, and a click focuses or opens `url`. Everything below fits that shape.

- **Push only for three things: the agent needs you (approval, question), a run failed, or a run finished that you asked to hear about.** Why: every notification for routine success trains the user to ignore all of them. Check: `review` of every server call site that sends a push.
- **`title` states the situation, `body` the specific item: "Approval needed" / "Send reply to Sam: Re: invoice #1042".** Why: the notification should be actionable from the shade without opening the app. Check: `review`.
- **`url` deep-links to the exact item (the approval card, the failed run), never to `/`.** Why: landing on Home and hunting is the most common push complaint. Check: `phone`: tap each notification type, landing on the item with it scrolled into view and focused.
- **`tag` is the item id, so updates to one item replace its notification instead of stacking.** Why: five notifications for one run is noise. Check: `phone`.
- **Opening the item in the app clears its notification (`getNotifications({ tag })` then `close()`).** Why: a handled item shouldn't wait in the shade. Check: `phone`.
- **Every push rings normally; none is sent with `silent: true`.** Why: the push rules above already keep routine success out of the shade, so what does arrive deserves a sound. Check: `review` of the push call site.
- **The permission prompt appears only after tapping an "Enable notifications" button that explains what will be sent.** Why: a cold permission prompt gets denied, and iOS requires a user gesture. Check: `phone`.
- **No badge counts for anything except items waiting on you.** Why: unread-message badges become noise. Check: `review`.

## Visual system

### Tokens

- **Colors come only from the tokens in `src/app.css`, never literal colors (`#hex`, `oklch(...)` in a class, `bg-[#...]`) or Tailwind palette colors (`text-red-500`).** Why: literal colors break dark mode and drift. Check: `rg -n -g '*.svelte' -e '-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' -e '\[#[0-9a-fA-F]{3,8}\]' -e '#[0-9a-fA-F]{6}\b' -g '!src/proto-routes/**' src` is empty (the proto's fake phone chrome is exempt); `src/app.css` is the only file that defines color values. `bun run lint` runs this check as `scripts/check-tokens.ts`.
- **Status meaning uses the status tokens, each paired with an icon and a label: `waiting`, `running`, `review`, `failed`, `taint`, plus `neutral`, via `StatePill`/`toneClass` in `src/lib/ui/status/status.ts`.** Why: one vocabulary across Home, chat and runs; color is never the only signal (WCAG 1.4.1). Check: `review`.
- **`--brand` (indigo) is for focus rings, selection and small accents; primary buttons stay `--primary`.** Why: one accent keeps status colors readable. Check: `shot`.
- **Every token pair used for text meets 4.5:1, and UI boundaries 3:1, in both themes.** Why: WCAG 1.4.3 / 1.4.11. Check: `axe` `color-contrast` in light and dark runs; for `*-soft` backgrounds, which axe can miss behind translucent layers, check by hand when a token changes.

### Type scale

| Role         | Size / line height | Use                             |
| ------------ | ------------------ | ------------------------------- |
| Screen title | 16px / semibold    | Header `h1`                     |
| Message body | 15px / 1.5         | Chat text, approval body        |
| UI text      | 14px               | List rows, buttons, form labels |
| Meta         | 12px               | Timestamps, captions, pills     |
| Code         | 12–13px mono       | Code blocks, ids, tool names    |
| Small label  | 11px / semibold    | Photo states, file chips        |

- **Nothing below 11px; body text never below 14px; inputs at least 16px.** Why: legibility at arm's length. Check: `review`.
- **Text sizes come from the type-scale tokens in `src/app.css` (`text-body`, `text-ui`, `text-meta`, `text-tab`, `text-code`) or Tailwind's rem sizes.** `scripts/check-tokens.ts` rejects `text-[Npx]`.
- **Text sizes use `rem`, never `px`.** Why: with `<meta name="text-scale" content="scale">` (already in `app.html`) the root font size follows the OS text-size setting in browsers that support it, but only `rem`/`em` text scales ([MDN text-scale](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/text-scale)); WCAG 1.4.4 Resize Text. Check: `phone` at the largest system font size; nothing clips or overlaps.
- **Sentence case everywhere; no Title Case, no ALL CAPS labels.** Why: easier to read, and matches the rest of the app. Check: `review`.

### Spacing and density

- **4px grid. Screen gutter 16px (`px-4`); list rows at least 48px tall; 16px between messages.** Why: one-handed use needs room between targets more than it needs density. Check: `shot`.
- **One column on phones. The desktop sidebar layout starts at the `@3xl` container width.** Why: phone first; desktop is a bonus. Check: `shot` at 412 and 1280.
- **Keep layout dimensions in shared components.** Why: per-screen widths and gutters drift when each caller repeats them. Check: `review`, `shot`: screen wrappers own sizing and scroll policy; content does not add competing outer widths or gutters.
- **Align visible content edges.** Why: a header or back control with unexplained inset looks detached from its content. Check: `shot` at 320px, 412px, and desktop: compare text and icon edges, not only control bounding boxes.
- **Line length of chat text at most ~70 characters on desktop.** Why: long lines are hard to track. Check: `shot` at 1280.

### Dark and light

- **Both themes are first-class; the default follows `prefers-color-scheme` and a manual toggle persists.** Why: the phone is used at night. Check: every `shot` is taken in both.
- **No pure black background (`--background` dark is `oklch(0.145 0 0)`).** Why: pure black smears on OLED when scrolling. Check: `review`.

### Motion

- **All transitions respect `prefers-reduced-motion: reduce`: they become instant or opacity-only.** Why: motion can cause nausea (WCAG 2.3.3, AAA, adopted here because it costs one media query). Check: `pw` with `page.emulateMedia({ reducedMotion: 'reduce' })`; no transform animations run.
- **Motion explains a change (a sheet rising, a message arriving), never decorates.** Why: decorative motion delays the user. Check: `review`.
- **The spinner icon (`LoaderCircle`) always comes with text.** Why: a spinner says nothing about what it waits on. Check: `review`.

### Tabs, swipes, and scroll ownership

- **Reuse the shared tabbed screen.** Use `ui/screen/TabbedScreen` for tabs with swipe navigation. It owns the screen shell, full-width pager, gutters, and panel scrolling. The import boundary check blocks direct feature imports of the pager engine.
- **Move panels with the finger.** Snap to the destination after release. Move the underline with the physical panel position. Use the same transition for a tab tap.
- **Keep labels readable.** When labels do not fit, allow horizontal scrolling within the tab bar. Keep the full label instead of an ellipsis. Keep the document width within the viewport.
- **Keep one vertical scroll owner per panel.** `TabbedScreen` disables outer scrolling and keeps the screen header and tab bar fixed. Supply content without an enclosing screen or extra vertical scroll container.
- **Preserve panel state.** Retain each panel's scroll offset, expanded rows, search input, and loaded older pages across tab changes.
- **Keep content stable during motion.** Commit filter requests after the destination panel settles. Keep loaded panels mounted during background refreshes. Do not rebuild the pager when text, content height, or keyboard height changes.
- **Recover interrupted gestures.** When the app loses focus or becomes hidden, release the gesture and align the committed panel. Do not leave the pager between tabs after an interrupted touch.
- **Keep focus within its intended area.** Reveal selected tabs through the tab bar's scroll offset. Do not use `scrollIntoView()` to move ancestor containers. Use `preventScroll` when keyboard navigation moves focus.
- **Keep spacing consistent.** `TabbedScreen` applies 16px content gutters and 16px space below the tab border. Supply lead and panel content without outer padding. Use `wide` for detailed desktop content. Keep padding inside cards.
- **Keep secondary buttons within content.** Give pagination and optional tracking buttons their content width. Keep optional MCP tracking controls below the Tools list. Do not change panel height through a footer that appears on one tab.
- **Keep other gestures available.** Preserve vertical scrolling, text selection, text input, and horizontal code scrolling. Reserve the screen edges for the drawer and system navigation.

The browser checks in `e2e/tab-swipe.test.ts` cover drag movement, snapping, keyboard navigation, reduced motion, retained state, and delayed refreshes. The connector checks also cover stable panel height. Every pager screen has alignment and scroll ownership checks at 320px and 412px. For each new pager screen, add a case to this shared usage check.

### Loading and background refresh

Treat first loads, background refreshes, and pagination as separate states. Cached content remains useful while a refresh runs.

| State                               | UI behavior                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| First load without content          | Keep the header and controls visible. For a noticeable wait, use delayed placeholders that match the row layout.          |
| Background refresh with content     | Keep cached content visible and mounted. Do not insert “Loading” or “Updating” text above existing rows.                  |
| Pagination                          | Show progress inside the existing “Show older” button. Keep its position stable. Append the new rows below existing rows. |
| Refresh failure with cached content | Keep the cached rows visible. Show the error and retry action below the list.                                             |
| First load failure                  | Show the error and a retry action in the content area.                                                                    |

Do not replace cached rows with skeletons during a refresh. Do not add a blocking spinner for routine background work. Use accessible status text without a layout change when an announcement is useful.

Fast requests do not need a flashing indicator. NN/g advises against skeletons and spinners for loads under one second. Apple recommends background loading that preserves access to other actions. These sources guide the interaction pattern, not a universal timeout.

Verification covers row positions before and after delayed refreshes. It also covers a data update during a held swipe and filter requests after panel arrival. Review mobile captures at 320px and 412px, plus desktop captures in both themes.

## UX writing

- **Plain verbs that name the action: "Approve and send", "Retry send", not "Submit" or "OK".** Why: the button should say what happens. Check: `review`.
- **Say "you" and "the agent"; no "we", no chirpy filler, no emoji in UI chrome.** Why: it's a tool, not a mascot. Check: `review`.
- **Errors say what happened and the next step, in one sentence each.** Why: users act on errors, they don't study them. Check: `review`.
- **Relative times for today ("2 min ago", "09:14"), full dates beyond.** Why: scannable and unambiguous. Check: `review`.

### Copy accuracy and dates

- **Use one term for each concept.** Why: different names for the same state suggest different behavior. Check: `review`: labels agree across navigation, list rows, detail views, and notifications.
- **Write one idea per sentence in active voice.** Why: direct instructions reduce rereading. Check: `review`: helper text names the action without filler or internal implementation terms.
- **Use input-neutral wording.** Why: people use touch, keyboards, and assistive technology. Check: `review`: instructions say “Select” rather than assuming a mouse click.
- **Do not promise unimplemented behavior.** Why: copy can create false expectations about permissions, completion, delivery, or recovery. Check: `review`: each claim matches the current behavior; unresolved decisions stay in technical notes.
- **Make date ranges compact and unambiguous.** Why: repeated timestamps obscure the difference. Check: `shot`: same-day ranges show the date once; cross-day ranges show both dates; seconds appear only when useful.
- **Keep timezone meaning consistent.** Why: the same instant can belong to different calendar days. Check: `review`, `pw`: displays use shared `ui/format/time.ts` helpers, identify non-local schedule zones, and cover midnight and daylight-saving boundaries when relevant.

## Accessibility

Target: WCAG 2.2 AA. The criteria that matter for this app, and how each is checked:

| Criterion                               | Where it bites here                                        | Check                          |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| 1.1.1 Non-text Content (A)              | Icon-only buttons (send, back, copy, overflow) need a name | `axe`, `check`                 |
| 1.3.1 Info and Relationships (A)        | Message list is a list; approval card is a labeled region  | `axe`, `review`                |
| 1.4.1 Use of Color (A)                  | Status pills, diff lines                                   | `review`                       |
| 1.4.3 / 1.4.11 Contrast (AA)            | Muted text, `*-soft` pills, borders, both themes           | `axe` light + dark             |
| 1.4.4 Resize Text (AA)                  | Android font scaling                                       | `phone`                        |
| 1.4.10 Reflow (AA)                      | Code, long URLs, tables at 320px                           | `pw` reflow                    |
| 2.1.1 Keyboard (A)                      | Approval tabs, tool rows, sheets on desktop                | `review`, manual keyboard pass |
| 2.2.1 Timing Adjustable (A)             | Approval cards and toasts that need action never expire    | `review`                       |
| 2.4.3 Focus Order / 2.4.7 Focus Visible | Sheets trap and return focus; `:focus-visible` ring stays  | manual keyboard pass           |
| 2.4.11 Focus Not Obscured (AA)          | Sticky composer vs focused items                           | `phone`, `scroll-padding`      |
| 2.5.7 Dragging Movements (AA)           | Swipe actions need a button alternative                    | `review`                       |
| 2.5.8 Target Size (AA)                  | 24px floor; this app's own rule is 48px                    | `axe` + `pw` 48px assertion    |
| 4.1.2 Name, Role, Value (A)             | Custom tabs, `div` dialogs, switches                       | `axe`, `check`                 |
| 4.1.3 Status Messages (AA)              | Delivery states, "Reconnecting", "Agent replied"           | `review` of `role="status"`    |

### axe setup

axe-core's `target-size` rule ships `enabled: false`, even under the `wcag22aa` tag, so enable it explicitly. **Call `.options()` before `.withTags()`**: `options()` replaces the whole options object, so called after `withTags()` it silently drops the `runOnly` tag filter (see `AxeBuilder` in `@axe-core/playwright` 4.13).

```ts
import AxeBuilder from '@axe-core/playwright';

const results = await new AxeBuilder({ page })
	.options({ rules: { 'target-size': { enabled: true } } }) // must come first
	.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
	.analyze();
expect(results.violations).toEqual([]);
```

- **Run axe on every screen in both themes and after driving each interactive state (sheet open, approval editing, tool row expanded).** Why: axe sees only the DOM present at `analyze()` time. Check: the e2e suite.
- **Reflow assertion at 320 and 412 wide: `document.documentElement.scrollWidth <= clientWidth`.** Why: 320 is WCAG 1.4.10's number (1280px at 400% zoom); 412 is the target phone. Check: `pw`.
- **`bun run check` runs with `--fail-on-warnings` so compiler `a11y_*` warnings fail the build.** Why: the Svelte compiler is the only a11y linter for templates; eslint-plugin-svelte has none. Check: `check`.
- **Review what automated scans cannot judge.** Why: a valid label can still be misleading, and hidden states escape a static scan. Check: `review`, keyboard pass: meaningful names, reading order, focus return, understandable errors, and hover/active-state contrast.
- **Screen-reader labels are real words: "Send message", "Back to Threads", "Copy code". Never "button", "icon", or the tool's internal name alone.** Why: axe checks that a name exists, not that it's useful. Check: `review`, plus a TalkBack pass on the phone for each new screen.

## The UX gate

A milestone is done only when all four steps pass. Steps 1–2 are cheap and run first; the phone step is last because it's the most expensive.

1. **Deterministic checks pass:** `bun run check` (fail on warnings), `bun run lint`, `bun run build`, and the Playwright suite at 412x915 (touch, `deviceScaleFactor: 2.625`, `isMobile: true`) including axe with `target-size`, the 48px assertion, reflow at 320 and 412, and the scroll-jank test.
2. **State matrix screenshots** are captured by Playwright and reviewed against this doc, rule by rule.
3. **Prototype parity:** the shipped screens match the `/proto` flow that was clicked through, or the difference is written down and agreed.
4. **Dogfood on the phone:** drk uses the installed PWA for real tasks for a day or two. Anything that annoys him is a bug and gets filed against this doc (either a rule is missing, or one was broken).

### State matrix

Capture each screen that changed in every state that applies, at 412x915 unless noted:

| State        | How to produce it                                               |
| ------------ | --------------------------------------------------------------- |
| Empty        | Fresh fixture with no data                                      |
| Loading      | Fixture server delays responses 3s                              |
| Error        | Fixture server returns 500 / the tool step fails                |
| Offline      | `context.setOffline(true)` after load                           |
| Long content | 200-column code line, 5 KB message, 60-char unbroken URL, table |
| 320px        | Viewport 320x640                                                |
| Dark         | `colorScheme: 'dark'` (and light for every other row)           |
| Keyboard     | `phone` only: composer focused, screenshot from the device      |

### What blocks a milestone

A UX bug blocks when any of these is true:

- A check in this doc fails (axe violation, a target under 48px, overflow at 320px, the scroll-jank test).
- Data loss: a typed message, a draft edit, or a pending approval can disappear without the user choosing it.
- A blocking wait, failure, or required action has no visible feedback. Cached background refreshes can remain quiet.
- Back does the wrong thing (exits the app, skips a screen, leaves an overlay open).
- The keyboard covers the composer or the focused field.
- A notification lands anywhere but the exact item.
- Something reads "done" or green when the evidence doesn't back it.
- drk hit it twice while dogfooding.

Everything else (spacing, wording, a slow-but-in-budget moment) is filed and fixed within the milestone if cheap, otherwise logged for the next.

## Anti-patterns

Seen in open-source agent UIs and chat apps. Don't ship any of these.

- **Raw tool JSON inline in the transcript** by default. Collapse it; the answer is the content.
- **A bare spinner or "Thinking…" with no step** for more than 2s.
- **Green "completed" for a run that only exited** without an error. Show evidence or `unverified`.
- **Auto-scroll that yanks the reader to the bottom** on every token.
- **Approval prompts that paraphrase the action**, time out, or vanish after a reload.
- **Uniform approval prompts for everything.** Approval fatigue trains click-through; ask only by exception and show why this one asked.
- **Desktop-first layouts** squeezed onto a phone: sidebars as hamburgers, hover-only actions, tooltips as the only label.
- **Enter-to-send on mobile**, and composers the keyboard hides.
- **Silent reconnects** that lose or duplicate messages, or a "please refresh" banner instead of resuming.
- **Notifications for every message**, or notifications that open the app's home.
- **Settings dumped as a raw JSON editor** as the only way to change something common.
- **Modals for reading material.** Use a bottom sheet for detail; keep dialogs for decisions.
- **History that can't be searched or linked**: every run, approval and memory change needs a URL.

## Known gaps in the prototype

Every frame on the board is a shipped feature screen, so the board breaks no rule the app keeps. Screens whose backend doesn't exist yet run on fixtures in the development preview; their gaps are in what the fixtures can show, not in the screens.

## Sources

- Android: [API defaults, 48dp targets](https://developer.android.com/develop/ui/compose/accessibility/api-defaults), [Touch target size](https://support.google.com/accessibility/android/answer/7101858)
- Loading: [Apple loading guidance](https://developer.apple.com/design/human-interface-guidelines/loading), [NN/g skeleton and progress guidance](https://www.nngroup.com/articles/skeleton-screens/), [SWR first-load and refresh states](https://swr.vercel.app/docs/advanced/understanding)
- Material 3: [Easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)
- Chrome: [Viewport resize behavior (`interactive-widget`)](https://developer.chrome.com/blog/viewport-resize-behavior), [Edge-to-edge on Android](https://developer.chrome.com/docs/css-ui/edge-to-edge)
- Close requests and text scaling: [MDN CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher), [MDN `<meta name="text-scale">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/text-scale)
- Performance: [web.dev INP](https://web.dev/articles/inp), [web.dev LCP](https://web.dev/articles/lcp)
- WCAG: [WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/), [Understanding 2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- axe: [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright), [axe-core rule descriptions](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- One-handed use: [Hoober, How do users really hold mobile devices](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)
- Agent products: [Claude routines](https://code.claude.com/docs/en/routines), [ChatGPT Dots](https://learn.chatgpt.com/docs/dots), [Grok Bot approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
