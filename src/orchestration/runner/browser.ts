import { spawn } from "node:child_process";
import { getLogger } from "../../logger.ts";
import { buildAgentEnv } from "./agentEnv.ts";

const log = getLogger("orchestration.runner.browser");

// Per-task agent-browser env: an isolated session, plus a pinned stream port so the runner can relay
// the live view without asking the daemon (which would launch a browser).
export function browserEnv(taskId: string, streamPort: number): Record<string, string> {
  return {
    AGENT_BROWSER_SESSION: taskId,
    AGENT_BROWSER_STREAM_PORT: String(streamPort),
    AGENT_BROWSER_STREAM_QUALITY: "75",
  };
}

// Best-effort: a session that never opened a browser just has nothing to close.
export function closeBrowserSession(session: string): void {
  const child = spawn("agent-browser", ["--session", session, "close"], {
    env: buildAgentEnv(process.env),
    stdio: "ignore",
    timeout: 15_000,
  });
  child.on("error", (err) => log.warn({ err, session }, "failed to close browser session"));
}
