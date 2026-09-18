# sushii-agent

AI agent Discord bot with guild config and OpenRouter.

## Runtime

- **Runtime:** Bun
- **Type check:** `bunx tsc --noEmit`
- **Install:** `bun install`
- **Dev:** `bun dev`

## Deployment

Auto-deploys via CI on every push to `main` (`.github/workflows/ci.yml`): `typecheck` +
`test` → `docker-build` → `deploy` (`private-bots/sushii-agent` on host `apps`). No manual
`deploy.sh` step is needed — pushing to `main` ships it. Verify with
`gh run list --branch main` and the post-deploy logs.
