# UX guidelines

Rules for every screen in the personal agent web app. The bar: better than the Discord DM it replaces, judged on a real Android phone, one-handed, not in a desktop browser.

Every rule has a one-line why and a check. A rule without a check is a wish, so review goes rule by rule and asks "did the check pass?"

The clickable prototype (`src/proto-routes/proto`, `src/lib/agent`) sets the design direction. Where the prototype breaks a rule below, the rule wins; see [Known gaps](#known-gaps-in-the-prototype).

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
- **The top bar holds title, back and secondary actions only.** Why: nothing there should need reaching for mid-task. Check: `review`.
- **Destructive or outward actions (Deny, Delete, Send now) are never the largest target and never sit where a mis-tap from the primary lands.** Why: Fitts's law works against you for dangerous actions. Check: `shot`.
- **No gesture-only actions. Every swipe or long-press has a visible button alternative.** Why: WCAG 2.5.7 Dragging Movements; gestures are undiscoverable. Check: `review`.

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
- **Keep the `--kb` visualViewport fallback for iOS, where `interactive-widget` has not shipped.** Why: iOS overlays the keyboard; the layout does not resize. Check: `review` (the fallback is already in `app-shell.svelte`).
- **The app root uses `100dvh` or `inset: 0`, never `100vh`.** Why: `100vh` ignores the dynamic browser UI and the keyboard. Check: `rg -n -g '!src/proto-routes/**' '100vh|h-screen' src` returns nothing (`h-screen`, `min-h-screen` and `max-h-screen` compile to `100vh`).
- **Anything pinned to the top or bottom pads with `env(safe-area-inset-*)`: the header adds `--safe-top`, the tab bar and composer add `--safe-bottom`.** Why: edge-to-edge content otherwise sits under the status bar and the gesture bar. Check: `phone` with gesture navigation on; nothing tappable overlaps the gesture pill.
- **The bottom tab bar hides while the keyboard is open.** Why: it eats a quarter of the space left above the keyboard. Check: `phone`.
- **Text inputs use a font size of at least 16px.** Why: iOS zooms the page on focus below 16px; the same size reads well on Android. Check: `pw` computed style on `textarea, input`.
- **`theme-color` matches `--background` in both themes, via two `<meta name="theme-color" media="(prefers-color-scheme: ...)">` tags or a script that follows the theme toggle.** Why: a white status bar over a dark app looks broken. Check: `phone` in light and dark.
- **`overscroll-behavior: none` on the document, `contain` on scroll regions.** Why: stops pull-to-refresh from reloading the app mid-chat and stops scroll chaining into the page. Check: `phone`: pull down at the top of a chat; the app does not reload.

### Back gesture and navigation

In a standalone PWA there is no browser back button: the Android back gesture is the only back control. It must do what the user expects on every screen.

- **Back closes the topmost overlay first (sheet, dialog, menu), and only then leaves the screen.** Why: Android sends a close request that native `<dialog>` and `popover` handle for free; a `div role="dialog"` ignores it and back navigates away instead ([MDN CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher)). This applies to the shadcn-svelte Dialog and Sheet too: bits-ui renders them as `div`s, so each needs the history-entry wrapper or a verified close on the phone. Build overlays on `<dialog>`/`popover`, or have them push a history entry and close on `popstate`. Check: `phone`: open every sheet and press back; the sheet closes and the screen stays.
- **Every pushed screen (chat, run detail, memory diff) is a real URL navigated with `goto`, never `replaceState` or in-component state.** Why: with one history entry, back exits the app. Check: `phone`: Home → chat → run detail, then back twice lands on Home.
- **Back from a top-level tab goes to Home; back from Home exits.** Why: the Android convention for bottom-nav apps. Check: `phone`.
- **A dirty composer or edit survives back and return.** Why: a mis-swipe must not cost a typed message. Keep the draft per chat in memory, and in `sessionStorage` for reloads. Check: `phone`: type, swipe back, reopen the chat; the text is there.
- **No `target="_blank"` for in-app routes.** Why: it opens a Custom Tab and breaks back. Check: `review`.
- **Tabs for top-level destinations only (Home, Chats, Briefing, More); detail screens show a back chevron and hide the tab bar.** Why: two navigation systems on one screen compete for the same thumb. Check: `shot`.

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

### Tool activity

- **The agent shows it is working within 300ms of receiving a message: a "Working" row, or the first tool line.** Why: silence past a few hundred ms reads as "it didn't get it". Check: `pw` against a fixture server with delayed replies.
- **Tool calls collapse into one "Working" row per turn that shows the current step in plain words ("Searching mail for 'invoice'") and a count ("4 steps").** Why: raw tool names and JSON in the transcript bury the answer. Check: `shot` of a turn with 5+ tool calls.
- **The row expands to the step list; each step expands to its exact input and output.** Why: the detail must be one tap away for debugging, never the default. Check: `phone`.
- **A failed step shows in the collapsed row ("1 step failed"), not only inside it.** Why: a collapsed failure is a hidden failure. Check: `shot`.
- **When the turn ends the row becomes a summary ("Used 4 tools · 12s") and stays collapsed.** Why: finished work should take one line of history. Check: `shot`.

### Approval cards

- **The card shows the exact inputs the tool will run with (recipient, subject, full body, command, URL), with an "Exact input" view of the raw arguments.** Why: paraphrased approvals are how bad actions get approved; Grok Bot shows "the proposed operation and its inputs" for the same reason. Check: `review` against the tool schema; `shot`.
- **Three actions: Approve, Edit, Deny. Approve names the action ("Approve and send").** Why: a bare "OK" hides what happens next. Check: `shot`.
- **Approval cards never auto-dismiss or time out in the UI. They stay until decided, and stay in history after with the decision and who or what made it.** Why: a missed approval that silently expires is a lost task; WCAG 2.2.1 Timing Adjustable. Check: `pw`: leave a card open 10 minutes; it's still actionable.
- **If the server withdraws a request (run cancelled), the card changes to "No longer needed" with the reason; it is not removed.** Why: things that disappear make the user doubt what they saw. Check: `shot`.
- **"Always allow" is a separate, off-by-default switch that says exactly what future actions it covers.** Why: a durable rule needs a deliberate choice. Check: `review`.
- **Tainted runs say so on the card ("This run read external email, so sending always asks first").** Why: it explains why this card appeared when an allow rule exists. Check: `shot`.
- **Every pending approval appears on Home under "Waiting on you" and in the tab badge.** Why: a card buried 40 messages up in a chat is effectively lost. Check: `pw`.

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

Every state has visible text. A spinner alone is a bug.

| State            | What the user sees                                                  | Check         |
| ---------------- | ------------------------------------------------------------------- | ------------- |
| Offline          | Top banner "Offline. Messages send when you reconnect."             | `pw` offline  |
| Reconnecting     | "Reconnecting…" with elapsed time after 5s; resumes on its own      | `pw`, `phone` |
| Reconnected      | Banner clears; missed messages load in place, no duplicate bubbles  | `pw`          |
| Queued send      | Bubble marked "Queued"                                              | `pw`          |
| Failed send      | Bubble marked "Failed" with Retry                                   | `pw`          |
| Agent working    | "Working" row with the current step                                 | `shot`        |
| Waiting on you   | Card in chat, item on Home, badge on the Home tab                   | `shot`        |
| Agent error      | Inline error naming the layer that failed (model, tool, connection) | `shot`        |
| Loading a screen | Skeleton with the screen's real layout after 300ms, never a blank   | `shot`        |
| Empty            | What will appear here, plus one next action                         | `shot`        |
| Update available | "Update ready · Reload"; never reloads on its own mid-typing        | `phone`       |

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
- **Quiet hours are a server policy: during them, needs-you pushes (approvals, questions) ring as usual, and every other push is sent with `silent: true`, never dropped.** Why: nothing is lost overnight, and only what waits on you makes a sound. Check: `review` of the push call site.
- **The permission prompt appears only after tapping an "Enable notifications" button that explains what will be sent.** Why: a cold permission prompt gets denied, and iOS requires a user gesture. Check: `phone`.
- **No badge counts for anything except items waiting on you.** Why: unread-message badges become noise. Check: `review`.

## Visual system

### Tokens

- **Colors come only from the tokens in `src/app.css`, never literal colors (`#hex`, `oklch(...)` in a class, `bg-[#...]`) or Tailwind palette colors (`text-red-500`).** Why: literal colors break dark mode and drift. Check: `rg -n -g '*.svelte' -e '-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' -e '\[#[0-9a-fA-F]{3,8}\]' -e '#[0-9a-fA-F]{6}\b' -g '!src/proto-routes/**' src` is empty (the proto's fake phone chrome is exempt); `layout.css` is the only file that defines color values.
- **Status meaning uses the status tokens, each paired with an icon and a label: `waiting`, `running`, `review`, `failed`, `taint`, plus `neutral`, via `StatePill`/`toneClass` in `status.ts`.** Why: one vocabulary across Home, chat and runs; color is never the only signal (WCAG 1.4.1). Check: `review`.
- **`--brand` (indigo) is for focus rings, selection and small accents; primary buttons stay `--primary`.** Why: one accent keeps status colors readable. Check: `shot`.
- **Every token pair used for text meets 4.5:1, and UI boundaries 3:1, in both themes.** Why: WCAG 1.4.3 / 1.4.11. Check: `axe` `color-contrast` in light and dark runs; for `*-soft` backgrounds, which axe can miss behind translucent layers, check by hand when a token changes.

### Type scale

| Role         | Size / line height        | Use                             |
| ------------ | ------------------------- | ------------------------------- |
| Screen title | 16px / semibold           | Header `h1`                     |
| Message body | 15px / 1.5                | Chat text, approval body        |
| UI text      | 14px                      | List rows, buttons, form labels |
| Meta         | 12px                      | Timestamps, captions, pills     |
| Tab label    | 11px / semibold on active | Bottom tab bar only             |
| Code         | 12–13px mono              | Code blocks, ids, tool names    |

- **Nothing below 11px; body text never below 14px; inputs at least 16px.** Why: legibility at arm's length. Check: `review`.
- **Text sizes use `rem`, never `px`.** Why: with `<meta name="text-scale" content="scale">` (already in `app.html`) the root font size follows the OS text-size setting in browsers that support it, but only `rem`/`em` text scales ([MDN text-scale](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/text-scale)); WCAG 1.4.4 Resize Text. Check: `phone` at the largest system font size; nothing clips or overlaps.
- **Sentence case everywhere; no Title Case, no ALL CAPS labels.** Why: easier to read, and matches the rest of the app. Check: `review`.

### Spacing and density

- **4px grid. Screen gutter 16px (`px-4`); list rows at least 48px tall; 16px between messages.** Why: one-handed use needs room between targets more than it needs density. Check: `shot`.
- **One column on phones. The desktop sidebar layout starts at the `@3xl` container width.** Why: phone first; desktop is a bonus. Check: `shot` at 412 and 1280.
- **Line length of chat text at most ~70 characters on desktop.** Why: long lines are hard to track. Check: `shot` at 1280.

### Dark and light

- **Both themes are first-class; the default follows `prefers-color-scheme` and a manual toggle persists.** Why: the phone is used at night. Check: every `shot` is taken in both.
- **No pure black background (`--background` dark is `oklch(0.145 0 0)`).** Why: pure black smears on OLED when scrolling. Check: `review`.

### Motion

- **All transitions respect `prefers-reduced-motion: reduce`: they become instant or opacity-only.** Why: motion can cause nausea (WCAG 2.3.3, AAA, adopted here because it costs one media query). Check: `pw` with `page.emulateMedia({ reducedMotion: 'reduce' })`; no transform animations run.
- **Motion explains a change (a sheet rising, a message arriving), never decorates.** Why: decorative motion delays the user. Check: `review`.
- **The spinner icon (`LoaderCircle`) always comes with text.** Why: a spinner says nothing about what it waits on. Check: `review`.

## UX writing

- **Plain verbs that name the action: "Approve and send", "Retry send", not "Submit" or "OK".** Why: the button should say what happens. Check: `review`.
- **Say "you" and "the agent"; no "we", no chirpy filler, no emoji in UI chrome.** Why: it's a tool, not a mascot. Check: `review`.
- **Errors say what happened and the next step, in one sentence each.** Why: users act on errors, they don't study them. Check: `review`.
- **Relative times for today ("2 min ago", "09:14"), full dates beyond.** Why: scannable and unambiguous. Check: `review`.

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
| 2.4.11 Focus Not Obscured (AA)          | Sticky composer and tab bar vs focused items               | `phone`, `scroll-padding`      |
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
- **Screen-reader labels are real words: "Send message", "Back to Chats", "Copy code". Never "button", "icon", or the tool's internal name alone.** Why: axe checks that a name exists, not that it's useful. Check: `review`, plus a TalkBack pass on the phone for each new screen.

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
- A state is silent: something is loading, failing or waiting with no text saying so.
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

The prototype currently breaks these rules. Fix each when its screen is ported out of `/proto`:

- The app-shell sheet is a `div role="dialog"`, so the Android back gesture does not close it.
- Tool calls render as one `<details>` per call instead of one collapsed "Working" row per turn.
- The chat has no "New messages" pill, no delivery states, and no offline or reconnecting banner.

## Sources

- Android: [API defaults, 48dp targets](https://developer.android.com/develop/ui/compose/accessibility/api-defaults), [Touch target size](https://support.google.com/accessibility/android/answer/7101858)
- Material 3: [Easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)
- Chrome: [Viewport resize behavior (`interactive-widget`)](https://developer.chrome.com/blog/viewport-resize-behavior), [Edge-to-edge on Android](https://developer.chrome.com/docs/css-ui/edge-to-edge)
- Close requests and text scaling: [MDN CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher), [MDN `<meta name="text-scale">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/text-scale)
- Performance: [web.dev INP](https://web.dev/articles/inp), [web.dev LCP](https://web.dev/articles/lcp)
- WCAG: [WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/), [Understanding 2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- axe: [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright), [axe-core rule descriptions](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- One-handed use: [Hoober, How do users really hold mobile devices](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)
- Agent products: [Claude routines](https://code.claude.com/docs/en/routines), [ChatGPT Dots](https://learn.chatgpt.com/docs/dots), [Grok Bot approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
