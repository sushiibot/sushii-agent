import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../../logger.ts";
import { OrchestrationClient } from "../transport/client.ts";
import { ClaudeCodeRunnerAdapter } from "./claudeCodeRunner.ts";

const log = getLogger("orchestration.runner");

// Discover the git repos this runner can work on: any explicit RUNNER_PROJECTS paths, plus a scan
// of RUNNER_ROOTS one level deep for directories containing .git (a root that is itself a repo
// counts too). Roots double as the dispatch scope fence — the orchestrator rejects a cwd that
// isn't one of these paths. Auto-discovered, so a freshly-cloned repo shows up with no config change.
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
  const runnerId = process.env.RUNNER_ID ?? `claude-code-${process.pid}`;
  const projects = discoverProjects();

  // Default (unset) = the adapter's acceptEdits host posture. Set RUNNER_PERMISSION_MODE=bypass
  // ONLY on a sandboxed runner (container/VM), where the CLI permits skipping all checks.
  const adapter = new ClaudeCodeRunnerAdapter({
    claudeBin: process.env.CLAUDE_BIN,
    permissionArgs:
      process.env.RUNNER_PERMISSION_MODE === "bypass" ? ["--dangerously-skip-permissions"] : undefined,
  });

  const client = new OrchestrationClient({
    url,
    runnerId,
    kind: "claude-code",
    projects,
    adapter,
  });

  log.info({ url, runnerId, projects }, "claude-code runner starting (auto-reconnect)");
  await client.run(); // reconnects with backoff + heartbeats until the process is stopped
}

main().catch((err) => {
  log.error({ err }, "claude-code runner daemon failed");
  process.exit(1);
});
