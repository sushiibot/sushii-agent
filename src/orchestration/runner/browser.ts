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
export function browserEnv(taskId: string, ports: BrowserPorts, browserUseApiKey?: string, runnerId?: string): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_BROWSER_SESSION: taskId,
    AGENT_BROWSER_STREAM_PORT: String(ports.local),
    AGENT_BROWSER_STREAM_QUALITY: "75",
  };
  if (ports.web && browserUseApiKey) {
    env.AGENT_BROWSER_WEB_STREAM_PORT = String(ports.web);
    env.AGENT_BROWSER_WEB_STATE = webStatePath(taskId);
    env.AGENT_BROWSER_WEB_RUNNER = runnerId ?? "unknown";
    env.BROWSER_USE_API_KEY = browserUseApiKey;
  }
  return env;
}

// Where agent-browser-web records the task's Browser Use session, so any later call (and cleanup) finds it.
function webStatePath(taskId: string): string {
  return `/tmp/sushii-browser-web/${taskId}.json`;
}

// Best-effort: a session that never opened a browser just has nothing to close. agent-browser-web
// close also stops the Browser Use session, which bills while open (CDP close alone does not).
export function closeBrowserSessions(taskId: string, browserUseApiKey?: string): void {
  run(["agent-browser", "--session", taskId, "close"], buildAgentEnv(process.env), taskId);
  if (browserUseApiKey) {
    const env = buildAgentEnv(process.env, {
      AGENT_BROWSER_SESSION: taskId,
      AGENT_BROWSER_WEB_STATE: webStatePath(taskId),
      BROWSER_USE_API_KEY: browserUseApiKey,
    });
    run(["agent-browser-web", "close"], env, taskId);
  }
}

function run(cmd: string[], env: NodeJS.ProcessEnv, taskId: string): void {
  const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: "ignore", timeout: 30_000 });
  child.on("error", (err) => log.warn({ err, taskId, cmd: cmd[0] }, "failed to close browser session"));
}
