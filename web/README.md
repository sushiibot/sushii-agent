# web

Personal agent web app: a SvelteKit SPA (adapter-static, `ssr = false`) installed as a PWA. The bot serves `build/` and the `/api` endpoints.

```sh
bun install
bun dev              # app at http://localhost:5173, /api proxied to http://localhost:8790
bun run check        # svelte-check, warnings fail
bun run lint         # prettier, scripts/check-no-raw-html.ts (no {@html} or DOM string sinks), check-tokens.ts, check-boundaries.ts (import directions)
bun run test:unit    # bun test: markdown rules and server-rendered components
bun run build        # app build in build/ (no prototype)
bun run test:e2e     # builds, then Playwright against `vite preview` with /api mocked
```

The clickable prototype lives in its own routes tree, `src/proto-routes`, so it never reaches `build/`:

```sh
bun run dev:proto    # http://localhost:5173/proto
bun run build:proto  # single-file board at build-proto/proto.html
```

Brand assets are rendered from the transparent PNG masters in `brand-src/` with
`bun scripts/render-icons.ts`. This rebuilds `static/brand/`, the favicon, install
icons, and the monochrome notification badge. The maskable icon keeps the character
inside the central safe area on a cream background. Generation prompts are saved
in `brand-src/prompts.json`.

## MCP connections

The bot serves Connectors when `WEB_FEATURES` includes `connectors`.
The workspace stores connections and credentials outside the browser.
The screen supports token or OAuth authentication, tool-list review, reconnection, disconnection, and removal.
See the root README for Fastmail setup and protocol limits.

## Layout

Imports point down this list only:

- `src/routes/`: thin containers that bind stores, `page.state` and navigation to screens.
- `src/lib/features/<name>/`: one folder per feature (screens, stores, reducers, fixtures). `features/chat/` holds every component that renders agent text, so the raw-HTML lint's strictest rules apply there.
- `src/lib/core/`: app infrastructure with no screens: the SSE stream (`realtime/`), IndexedDB (`storage/`), PWA and push (`pwa/`), service-worker logic (`sw/`).
- `src/lib/ui/`: the design system, with no domain imports. shadcn-svelte adds components here (`components.json`).

Every screen on the prototype board is a feature's own screen, rendered from its `fixtures.ts`; the board imports features only through `index.ts` and `fixtures.ts`. Screens whose backend doesn't exist yet (skills, schedules, browser, briefing) call the routes that backend will serve (`api.ts`) and show only while their feature is on: `/api/me` `features`, plus the device override in `localStorage` `features:override` (`all` or a comma list). Their fixture APIs (`fake.ts`) never reach the app build (`scripts/bundle-guard.ts`): `bun dev` with `?fake` installs them from `src/routes/dev-fakes.ts` with every feature on, where `fixtures:<feature>` picks the state a fake serves (`empty`, `error`, `slow`, `offline`, `unsupported`), and the e2e suite serves the same APIs over `context.route` (`e2e/fixture-routes.ts`).

A screen is built from `ui/screen` (`Screen`, `ListScreen`, `DetailScreen`, `ScreenState`) inside the root layout's `Shell`, with data from a feature store (`core/remote.svelte.ts` for fetched data, `core/realtime/hub.svelte.ts` for the stream). Sheets are `ui/sheet/routed-sheet.svelte`, opened through `core/nav/sheet.ts` so Android back closes them. Screens, their `components/` and `render/` take props and callbacks only, so the prototype board and the e2e harness can render them from fixtures.

## Topic conversations

The bot serves topic conversations when `WEB_FEATURES` includes `threads`.
Each topic has a separate persisted workspace session and chat stream.
See [Topic threads](docs/topic-threads.md) for routing, shared memory, lifecycle, and tests.

## Memory browser

The bot serves read-only Memory when `WEB_FEATURES` includes `memory`. Long-term shows
`USER.md`, `MEMORY.md`, `DREAMS.md` and other markdown under the workspace's `memory/`.
Daily notes shows `memory/YYYY-MM-DD.md`; History holds work recaps and run records.
The browser reads the real workspace files and offers file-name search. It does not
expose editing or revert actions. File reads are capped at 256 KB and directory scans
are capped at 500 files, with a visible notice when content is limited.
