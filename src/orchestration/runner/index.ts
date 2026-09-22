import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../../logger.ts";
import type { RunnerAdapter } from "../contracts.ts";
import { OrchestrationClient } from "../transport/client.ts";
import { ClaudeCodeRunnerAdapter } from "./claudeCodeRunner.ts";
import { PiRunnerAdapter } from "./piRunner.ts";
import { buildEnvironmentContext, probeTools } from "./envContext.ts";
import { tokenProviderFromEnv } from "./githubApp.ts";
import type { RepoOpsDeps } from "./repoOps.ts";

const log = getLogger("orchestration.runner");

// Kind → adapter factory. Adding a runner kind (e.g. Hermes) is a new entry here + an adapter
// implementing RunnerAdapter — nothing else in the transport/orchestrator changes, since every
// kind speaks the same start/resume/stream/interrupt contract.
interface AdapterContext {
  runnerId: string;
  location: string | null;
  workspaceRoot: string | null;
}

const ADAPTERS: Record<string, (ctx: AdapterContext) => RunnerAdapter> = {
  "claude-code": () =>
    new ClaudeCodeRunnerAdapter({
      claudeBin: process.env.CLAUDE_BIN,
      // Default (unset) = the adapter's acceptEdits host posture. RUNNER_PERMISSION_MODE=bypass
      // ONLY on a sandboxed runner (container/VM), where the CLI permits skipping all checks.
      permissionArgs: process.env.RUNNER_PERMISSION_MODE === "bypass" ? ["--dangerously-skip-permissions"] : undefined,
    }),
  pi: (ctx) => {
    const model = process.env.RUNNER_MODEL;
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
    const agentDir = process.env.RUNNER_AGENT_DIR ?? `${process.env.HOME}/.pi-runner`;
    if (!model) throw new Error("RUNNER_KIND=pi requires RUNNER_MODEL");
    if (!apiKey) throw new Error("RUNNER_KIND=pi requires OPENAI_API_KEY");
    const rawTtl = Number(process.env.RUNNER_WORKTREE_TTL_HOURS ?? "24");
    const ttlHours = Number.isFinite(rawTtl) ? rawTtl : 24;
    const repoOps = buildRepoOps();
    // Probed once at startup: the image is fixed for the process lifetime.
    const tools = probeTools();
    const environmentContext = buildEnvironmentContext(
      { ...ctx, workspaceRoot: repoOps ? ctx.workspaceRoot : null, worktreeTtlHours: ttlHours },
      tools,
    );
    return new PiRunnerAdapter({
      model,
      apiKey,
      baseUrl,
      agentDir,
      environmentContext,
      browser: tools.some((t) => t.name === "agent-browser"),
      repoOps,
      workspaceRoot: ctx.workspaceRoot,
      worktreeTtlMs: ttlHours * 3600_000,
    });
  },
  // hermes: reserved — add a HermesRunnerAdapter implementing RunnerAdapter and register it here.
};

// Discover the git repos this runner can work on: any explicit RUNNER_PROJECTS paths, plus a scan
// of RUNNER_ROOTS one level deep for directories containing .git (a root that is itself a repo
// counts too). Roots double as the dispatch scope fence — the orchestrator rejects a cwd that
// isn't one of these paths. Auto-discovered, so a freshly-cloned repo shows up with no config change.
// Clone-on-demand deps for the Pi runner: a per-repo token provider (GitHub App) + the bot commit
// identity. undefined when the App is unconfigured — a repo dispatch is then rejected upstream
// rather than half-cloning without a credential.
function buildRepoOps(): RepoOpsDeps | undefined {
  const provider = tokenProviderFromEnv();
  if (!provider) return undefined;
  return {
    provider,
    bot: {
      name: process.env.GITHUB_BOT_NAME ?? "sushii-runner[bot]",
      email: process.env.GITHUB_BOT_EMAIL ?? "sushii-runner@users.noreply.github.com",
    },
  };
}

function discoverProjects(): string[] {
  const explicit = (process.env.RUNNER_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const roots = (process.env.RUNNER_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const found = new Set(explicit);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (existsSync(join(root, ".git"))) found.add(root);
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, ".git"))) found.add(dir);
      } catch {
        // unreadable entry — skip
      }
    }
  }
  return [...found];
}

async function main(): Promise<void> {
  const url = process.env.ORCH_URL ?? "ws://localhost:8788";
  const kind = process.env.RUNNER_KIND ?? "claude-code";
  const runnerId = process.env.RUNNER_ID ?? `${kind}-${process.pid}`;
  const projects = discoverProjects();
  // Dir this runner clones on-demand repos into. Declaring it engages the dispatch scope fence
  // (see Dispatcher.cwdInScope) even when RUNNER_ROOTS is empty, so an unconfigured clone-runner
  // is not silently permissive.
  const workspaceRoot = process.env.RUNNER_WORKSPACE?.trim() || null;

  const location = process.env.RUNNER_LOCATION?.trim() || null;
  const factory = ADAPTERS[kind];
  if (!factory) throw new Error(`unknown RUNNER_KIND "${kind}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  const adapter = factory({ runnerId, location, workspaceRoot });

  const client = new OrchestrationClient({ url, runnerId, kind, projects, workspaceRoot, location, adapter });

  log.info({ url, runnerId, kind, projects, workspaceRoot, location }, "runner starting (auto-reconnect)");
  await client.run(); // reconnects with backoff + heartbeats until the process is stopped
}

main().catch((err) => {
  log.error({ err }, "runner daemon failed");
  process.exit(1);
});
