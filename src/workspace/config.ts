import { join, resolve } from "node:path";
import { isValidAt, isValidTimeZone } from "./scheduler.ts";

export type WorkspaceProvider = "chatgpt" | "openrouter";

export interface WorkspaceConfig {
  orchUrl: string;
  orchSecret: string;
  principalId: string;
  /** Primary backend; OpenRouter is always the fallback. */
  provider: WorkspaceProvider;
  /** Model id on Pi's `openai` provider, used under Sign in with ChatGPT. */
  chatgptModel: string;
  /** OpenRouter model id. */
  model: string;
  apiKey: string;
  baseUrl: string;
  agentDir: string;
  home: string;
  stateDir: string;
  /** IANA zone for scheduled jobs. */
  tz: string;
  /** Local "HH:MM" of the nightly memory consolidation. */
  consolidateAt: string;
}

export class WorkspaceConfigError extends Error {}

export function loadWorkspaceConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceConfig {
  const orchSecret = env.ORCH_SECRET?.trim();
  if (!orchSecret) throw new WorkspaceConfigError("ORCH_SECRET is required: the bot rejects a workspace registration without it");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new WorkspaceConfigError("OPENAI_API_KEY is required (OpenRouter key for the workspace model)");
  const home = env.HOME;
  if (!home) throw new WorkspaceConfigError("HOME is required: it is the personal agent's working directory");
  const provider = env.WORKSPACE_PROVIDER?.trim() || "chatgpt";
  if (provider !== "chatgpt" && provider !== "openrouter") {
    throw new WorkspaceConfigError(`WORKSPACE_PROVIDER must be "chatgpt" or "openrouter", got "${provider}"`);
  }
  const tz = env.WORKSPACE_TZ?.trim() || "UTC";
  if (!isValidTimeZone(tz)) throw new WorkspaceConfigError(`WORKSPACE_TZ must be an IANA time zone, got "${tz}"`);
  const consolidateAt = env.WORKSPACE_CONSOLIDATE_AT?.trim() || "04:00";
  if (!isValidAt(consolidateAt)) throw new WorkspaceConfigError(`WORKSPACE_CONSOLIDATE_AT must be HH:MM, got "${consolidateAt}"`);
  return {
    orchUrl: env.ORCH_URL || "ws://localhost:8788",
    orchSecret,
    principalId: env.WORKSPACE_PRINCIPAL || "drk",
    provider,
    chatgptModel: env.WORKSPACE_CHATGPT_MODEL?.trim() || "gpt-6.1-sol",
    model: env.WORKSPACE_MODEL || "openai/gpt-6-luna",
    apiKey,
    baseUrl: env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
    // Pi's own variable, so the `pi` CLI (used for /login) and this process share auth.json.
    agentDir: env.PI_CODING_AGENT_DIR || env.PI_AGENT_DIR || join(home, ".pi-workspace"),
    home,
    // Sibling of HOME, so prod (HOME=/data/home) lands on /data/.workspace outside the home repo.
    stateDir: env.WORKSPACE_STATE_DIR || resolve(home, "..", ".workspace"),
    tz,
    consolidateAt,
  };
}
