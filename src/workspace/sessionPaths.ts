import { join, resolve } from "node:path";

/** Where each kind of agent session persists its Pi JSONL, under PI_CODING_AGENT_DIR. */
export const SESSION_DIRS = {
  chat: "chat",
  subagents: "subagents",
  jobs: "job-sessions",
} as const;

export function chatSessionDir(agentDir: string): string {
  return join(agentDir, SESSION_DIRS.chat);
}

/** Session dir for the children of one run. */
export function subagentSessionDir(agentDir: string, parentRunId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(parentRunId)) throw new Error(`invalid parentRunId: ${parentRunId}`);
  return join(agentDir, SESSION_DIRS.subagents, parentRunId);
}

export function jobSessionDir(agentDir: string): string {
  return join(agentDir, SESSION_DIRS.jobs);
}

export function sessionRoots(agentDir: string): string[] {
  return Object.values(SESSION_DIRS).map((d) => join(agentDir, d));
}

/** Same default as the workspace config: a sibling of HOME. */
export function resolveStateDir(env: NodeJS.ProcessEnv): string | null {
  if (env.WORKSPACE_STATE_DIR) return env.WORKSPACE_STATE_DIR;
  return env.HOME ? resolve(env.HOME, "..", ".workspace") : null;
}

/** The workspace image's agent dir. `ws-runs` reads sessions only under it: env and state.json are
 *  agent-writable, so neither may move the session roots. */
export const DEFAULT_AGENT_DIR = "/data/pi-agent";

export function pinnedAgentDirs(): string[] {
  return [DEFAULT_AGENT_DIR];
}
