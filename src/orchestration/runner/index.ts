import { getLogger } from "../../logger.ts";
import { OrchestrationClient } from "../transport/client.ts";
import { ClaudeCodeRunnerAdapter } from "./claudeCodeRunner.ts";

const log = getLogger("orchestration.runner");

async function main(): Promise<void> {
  const url = process.env.ORCH_URL ?? "ws://localhost:8787";
  const runnerId = process.env.RUNNER_ID ?? `claude-code-${process.pid}`;
  const projects = (process.env.RUNNER_PROJECTS ?? "").split(",").filter(Boolean);

  const adapter = new ClaudeCodeRunnerAdapter({
    claudeBin: process.env.CLAUDE_BIN,
  });

  const client = new OrchestrationClient({
    url,
    runnerId,
    kind: "claude-code",
    projects,
    adapter,
  });

  await client.connect();
  client.listen();
  log.info({ url, runnerId, projects }, "claude-code runner connected");
}

main().catch((err) => {
  log.error({ err }, "claude-code runner daemon failed");
  process.exit(1);
});
