# e2e-system

End-to-end tests against the real processes. The runner builds `web/` and starts:

| Production piece | Here |
|---|---|
| bot (`src/index.ts`, `NODE_ENV=production`) | a bot process bound to `E2E_BOT_ADDR` (127.0.0.2), with `WEB_TRUSTED_PEERS` set to the proxy's peer address. The Discord login is stubbed (`stack/discord-stub.preload.ts`). |
| workspace (`src/workspace/index.ts`) | a workspace process running the real Pi session, connected to the bot over the real orchestration WebSocket |
| OpenRouter | `stack/fake-llm.ts`, which returns scripted streaming chat completions |
| Traefik + Tailscale whois shim | `stack/proxy.ts`. It strips client `Tailscale-*` headers, sets the owner login, and dials the bot from `E2E_PEER_ADDR` (127.0.0.3). |
| attacker on the network | requests from `E2E_UNTRUSTED_ADDR` (127.0.0.5) |

Chromium runs at 412×915 (mobile, touch) and goes through the proxy.

## Run it

```sh
bun install && (cd web && bun install) && (cd e2e-system && bun install)
(cd e2e-system && bunx playwright install chromium)   # once
bun run e2e:system                    # all flows
bun run e2e:system approval           # extra args go to `playwright test`
E2E_SKIP_BUILD=1 bun run e2e:system   # reuse web/build
```

Each run gets a fresh temp dir holding the bot DB, the workspace home, the generated VAPID pair and secrets, the logs (`logs/{llm,proxy,bot,ws}.log`) and Playwright's output (traces and screenshots of failures).
- The dir is deleted after a green run.
- It is kept after a failure or with `E2E_KEEP=1`; the runner prints its path.

Every process is stopped on exit, including a failed start or Ctrl-C.

### Settings

| Env | Default | |
|---|---|---|
| `E2E_PORT_BASE` | `4500` | proxy = base, web = +1, llm = +2, mcp = +3, orch = +4, control = +5. Give each worktree its own base. |
| `E2E_PROXY_PORT`, `E2E_WEB_PORT`, `E2E_LLM_PORT`, `E2E_MCP_PORT`, `E2E_ORCH_PORT`, `E2E_CONTROL_PORT` | from the base | set a single port |
| `E2E_PROXY_ADDR` | `127.0.0.1` | where the browser reaches the proxy. Not `localhost`: GitHub's runners resolve it to `::1` first. |
| `E2E_BOT_ADDR`, `E2E_PEER_ADDR`, `E2E_UNTRUSTED_ADDR` | `127.0.0.2`, `.3`, `.5` | must all be in 127.0.0.0/8 |
| `E2E_OWNER_LOGIN` | `owner@e2e` | |
| `E2E_TMP_DIR` | a new `$TMPDIR/sushii-e2e-*` | must be empty or absent (CI sets it to upload the dir) |
| `E2E_SKIP_BUILD`, `E2E_KEEP` | unset | `1` to enable |

**Loopback aliases.** Linux routes all of 127.0.0.0/8 to `lo`, so nothing needs setting up there, including GitHub's `ubuntu-latest`. On macOS, add the aliases first (`sudo ifconfig lo0 alias 127.0.0.2` and the same for `.3` and `.5`). The runner's preflight checks this and the ports before it starts anything.

**Isolation.**
- Each process gets an env built from scratch and runs with `bun --no-env-file`, so neither the repo `.env` nor the caller's tokens reach the stack.
- `stack/net-guard.preload.ts` answers the OpenRouter model catalog locally. The URL is hard-coded in `src/agentRuntime/piShared.ts`, and the catalog has to list `image` or the workspace drops photos. It refuses every other non-loopback `fetch` and logs `[e2e-net] blocked …`.
- discord.js REST uses undici directly, so the guard does not cover it. With the login stubbed, the bot sends nothing.

## Adding a flow

Add one file per flow, `flows/<name>.e2e.ts`. Don't use `.test.ts`: the root `bun test` would pick that up. Flows run one at a time against one shared stack and database, in file-name order. So:
- Put `nonce()` in every message you send.
- Assert only on your own messages.
- Leave the stack running. `restartBot` waits for it to come back.

```ts
import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("my flow", async ({ page, watch }) => {
  await openChat(page);
  const text = `E2E-ECHO ${nonce()}`;
  expect((await send(page, text)).status).toBe(202);
  await expect(bubble(page, "Echo ")).toBeVisible();
  const seen = await stack.waitForLlm((r) => r.userText.includes(text));
  const rows = await stack.query("select type from web_events where data like ?", `%${text}%`);
  expect(await watch.violations()).toEqual([]);
});
```

`lib/harness.ts`:
- `test` adds the `watch` fixture, which records CSP and Trusted Types violations and console errors.
- `stack.llmLog()` and `stack.waitForLlm(match)` return what the fake model received.
- `stack.query(sql, ...params)` runs a read-only query on the bot DB. It uses `bun:sqlite` in the runner, because flows run in node.
- `stack.restartBot({ waitReady })` sends the bot SIGTERM and starts it again on the same data.
- `stack.wsHome` is the workspace `$HOME`. `stack.config` holds the ports and addresses.

`lib/chat.ts` has `openChat`, `send`, `textbox` and `bubble`. When the app's routes change (e.g. Home moves to `/`), update `openChat` there, not in each flow.

New stack capabilities go in `run.ts`'s control server, not in the flows:
- a route (e.g. `POST /workspace/restart`);
- a thin wrapper in `stack`.

**Fake model script.** The fake model picks a reply from the last user message. Add a keyword in `stack/fake-llm.ts` when a flow needs one.

| Keyword | Reply |
|---|---|
| `E2E-ECHO <word>` | `Echo <word>.` |
| `E2E-APPROVE` | a `file_linear_issue` tool call (needs an approval) |
| `E2E-PHOTO` | `I received N image part(s) in this turn …` |
| `E2E-SLOW` | 30 pieces `slow0 … slow29`, 500 ms apart |
| `E2E-FILL-<n>` | `Filler reply <n>.` |
| a tool result | `Tool finished. Result: …` |
| anything else | markdown: bold, a two-item list, a `ts` code block, `Done.` |

## CI

The `e2e-system` job in `.github/workflows/ci.yml` runs this on every push. `docker-build` and `docker-build-workspace` both need it, so a red run blocks the deploy. On failure the job uploads the temp dir (logs and traces) as the `e2e-system` artifact.
