import { join, resolve } from "node:path";

export interface WorkspaceConfig {
  orchUrl: string;
  orchSecret: string;
  principalId: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  agentDir: string;
  home: string;
  stateDir: string;
}

export class WorkspaceConfigError extends Error {}

export function loadWorkspaceConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceConfig {
  const orchSecret = env.ORCH_SECRET?.trim();
  if (!orchSecret) throw new WorkspaceConfigError("ORCH_SECRET is required: the bot rejects a workspace registration without it");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new WorkspaceConfigError("OPENAI_API_KEY is required (OpenRouter key for the workspace model)");
  const home = env.HOME;
  if (!home) throw new WorkspaceConfigError("HOME is required: it is the personal agent's working directory");
  return {
    orchUrl: env.ORCH_URL || "ws://localhost:8788",
    orchSecret,
    principalId: env.WORKSPACE_PRINCIPAL || "drk",
    model: env.WORKSPACE_MODEL || "openai/gpt-6-luna",
    apiKey,
    baseUrl: env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
    agentDir: env.PI_AGENT_DIR || join(home, ".pi-workspace"),
    home,
    // Sibling of HOME, so prod (HOME=/data/home) lands on /data/.workspace outside the home repo.
    stateDir: env.WORKSPACE_STATE_DIR || resolve(home, "..", ".workspace"),
  };
}
