import { spawn } from "node:child_process";
import { getLogger } from "../../logger.ts";
import { buildAgentEnv } from "./agentEnv.ts";
import { allocatePort } from "./browserStream.ts";

const log = getLogger("orchestration.runner.browser");

// Stream ports for a task's browsers: the local one, plus the Browser Use cloud one when configured.
// Each daemon needs its own port, and pinning them lets the runner relay the live view without
// asking the daemon (which would launch a browser).
export interface BrowserPorts {
  local: number;
  web: number | null;
}

export async function allocateBrowserPorts(cloud: boolean): Promise<BrowserPorts> {
  return { local: await allocatePort(), web: cloud ? await allocatePort() : null };
}

// Per-task agent-browser env. `agent-browser-web` (a wrapper in the image) reads the WEB_* values to
// run the same commands against a Browser Use cloud browser in a sibling session.
export function browserEnv(taskId: string, ports: BrowserPorts, browserUseApiKey?: string): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_BROWSER_SESSION: taskId,
    AGENT_BROWSER_STREAM_PORT: String(ports.local),
    AGENT_BROWSER_STREAM_QUALITY: "75",
  };
  if (ports.web && browserUseApiKey) {
    env.AGENT_BROWSER_WEB_STREAM_PORT = String(ports.web);
    env.BROWSER_USE_API_KEY = browserUseApiKey;
  }
  return env;
}

// Best-effort: a session that never opened a browser just has nothing to close. Closing the cloud
// session also ends the Browser Use session, which bills while open.
export function closeBrowserSessions(taskId: string, browserUseApiKey?: string): void {
  close(taskId, buildAgentEnv(process.env));
  if (browserUseApiKey) {
    close(`${taskId}-web`, buildAgentEnv(process.env, { AGENT_BROWSER_PROVIDER: "browseruse", BROWSER_USE_API_KEY: browserUseApiKey }));
  }
}

function close(session: string, env: NodeJS.ProcessEnv): void {
  const child = spawn("agent-browser", ["--session", session, "close"], { env, stdio: "ignore", timeout: 15_000 });
  child.on("error", (err) => log.warn({ err, session }, "failed to close browser session"));
}
