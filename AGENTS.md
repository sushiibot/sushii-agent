# sushii-agent

AI agent community bot for Discord, Slack and buzz, with per-team config and OpenRouter.
The personal agent (web app and workspace) lives in sushiibot/omakase.

## Runtime

- **Runtime:** Bun
- **Entry:** `src/index.ts`
- **Type check:** `bunx tsc --noEmit`
- **Test:** `bun test` (`src/index.boot.test.ts` boots the bot on the bot env alone)
- **Install:** `bun install`
- **Dev:** `bun dev` (`./data/sushii-agent.db`; `DATABASE_PATH` overrides it)

## Database

`drizzle/` holds the applied migrations; never edit, delete or renumber them. `src/db/schema.ts`
must stay consistent with them, including tables the bot no longer reads.

## Deployment

When work is finalized and checks pass, commit and push to `main` without asking for confirmation.

Auto-deploys via CI on every push to `main` (`.github/workflows/ci.yml`): `typecheck` and `test` →
`docker-build` → `deploy` (`private-bots/sushii-agent` on host `apps`). No manual `deploy.sh` step is
needed — pushing to `main` ships it. Push any sushii-ansible config change first: the deploy renders
from sushii-ansible `main`. Verify with `gh run list --branch main` and the post-deploy logs.
