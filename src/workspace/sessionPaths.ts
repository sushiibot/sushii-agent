import { join, resolve } from "node:path";
import { readWorkspaceState } from "./state.ts";

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

/**
 * The agent's bash drops PI_*, so without PI_CODING_AGENT_DIR the dir is taken from the recorded
 * chat session (`<agentDir>/chat/<file>`). Callers must still confine reads to its session roots.
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv, stateDir: string | null): string | null {
  const fromEnv = env.PI_CODING_AGENT_DIR || env.PI_AGENT_DIR;
  if (fromEnv) return fromEnv;
  const chat = stateDir ? readWorkspaceState(stateDir)?.chatSessionFile : undefined;
  if (chat) return resolve(chat, "..", "..");
  return env.HOME ? join(env.HOME, ".pi-workspace") : null;
}
