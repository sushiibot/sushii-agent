import { spawn } from "node:child_process";
import { getLogger } from "../../logger.ts";
import { buildAgentEnv } from "./agentEnv.ts";

const log = getLogger("orchestration.runner.browser");

// Best-effort: a session that never opened a browser just has nothing to close.
export function closeBrowserSession(session: string): void {
  const child = spawn("agent-browser", ["--session", session, "close"], {
    env: buildAgentEnv(process.env),
    stdio: "ignore",
    timeout: 15_000,
  });
  child.on("error", (err) => log.warn({ err, session }, "failed to close browser session"));
}
