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

Icons are rendered from `icons-src/*.svg` with `bun scripts/render-icons.ts`.

## Layout

Imports point down this list only:

- `src/routes/`: thin containers that bind stores, `page.state` and navigation to screens.
- `src/lib/features/<name>/`: one folder per feature (screens, stores, reducers, fixtures). `features/chat/` holds every component that renders agent text, so the raw-HTML lint's strictest rules apply there.
- `src/lib/core/`: app infrastructure with no screens: the SSE stream (`realtime/`), IndexedDB (`storage/`), PWA and push (`pwa/`), service-worker logic (`sw/`).
- `src/lib/ui/`: the design system, with no domain imports. shadcn-svelte adds components here (`components.json`).

Screens that no milestone has shipped yet wait in `src/proto-routes/proto/screens/`.

A screen is built from `ui/screen` (`Screen`, `ListScreen`, `DetailScreen`, `ScreenState`) inside the root layout's `Shell`, with data from a feature store (`core/remote.svelte.ts` for fetched data, `core/realtime/hub.svelte.ts` for the stream). Sheets are `ui/sheet/routed-sheet.svelte`, opened through `core/nav/sheet.ts` so Android back closes them. Screens, their `components/` and `render/` take props and callbacks only, so the prototype board and the e2e harness can render them from fixtures.
