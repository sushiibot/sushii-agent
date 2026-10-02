# sushii-agent

AI agent Discord bot with guild config and OpenRouter.

## Runtime

- **Runtime:** Bun
- **Type check:** `bunx tsc --noEmit`
- **Install:** `bun install`
- **Dev:** `bun dev`

## Web app (`web/`)

Owner-only SvelteKit SPA (PWA) served by the bot's web gateway at agent.sushii.bot (tailnet only).
Structure and rules: `web/README.md`, `web/docs/ux-guidelines.md`. Gate from `web/`: `bun run check`,
`bun run lint` (prettier + raw-HTML, token and import-boundary checks + unit tests), `bun run build`,
`bun run test:e2e` (ports via `PW_PORT` / `PW_HARNESS_PORT`). Dev with sample data: `bun dev`, then `?fake`.
Screens not yet backed by the bot are hidden by feature flags; the bot's `WEB_FEATURES` lists the live ones.

## End-to-end system tests (`e2e-system/`)

Real bot + real workspace + fake model + Traefik-like proxy, driven by Chromium: `bun run e2e:system`
(port slot via `E2E_PORT_BASE`; avoid 5060, Chromium blocks it). One flow per file in `e2e-system/flows/`.

## Deployment

When work is finalized and checks pass, commit and push to `main` without asking for confirmation.

Auto-deploys via CI on every push to `main` (`.github/workflows/ci.yml`): `typecheck`, `test`, `web`,
`browser-smoke` and `e2e-system` → `docker-build` / `docker-build-workspace` → `deploy`
(`private-bots/sushii-agent` on host `apps`) → `deploy-workspace` (`private-bots/sushii-agent-workspace`,
after the bot). No manual `deploy.sh` step is needed — pushing to `main` ships it. Push any
sushii-ansible config change first: the deploy renders from sushii-ansible `main`. Verify with
`gh run list --branch main` and the post-deploy logs.
