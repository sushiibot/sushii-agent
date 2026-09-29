import { join, resolve } from "node:path";
import { isValidAt, isValidTimeZone, parseActiveHours, parseWhen, type JobSchedule } from "./scheduler.ts";

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
  /** The built-in heartbeat job's schedule; null when disabled. */
  heartbeat: JobSchedule | null;
  /** Most proactive messages all scheduled jobs together may send in any 24 h. */
  proactiveDailyCap: number;
  /** Model-judged gate on the main agent's risky tool calls. Absent means off. */
  autoMode?: boolean;
  /** OpenRouter model id of the auto-mode judge, used while the shared backend is on OpenRouter. */
  judgeModel?: string;
  /** Model id on Pi's `openai` provider for the judge while the shared backend is on ChatGPT. */
  judgeChatgptModel?: string;
}

export const DEFAULT_HEARTBEAT_MINUTES = 120;
export const DEFAULT_HEARTBEAT_ACTIVE = "08:00-22:00";
export const DEFAULT_PROACTIVE_DAILY_CAP = 6;

function loadHeartbeat(env: NodeJS.ProcessEnv): JobSchedule | null {
  const every = env.WORKSPACE_HEARTBEAT_EVERY?.trim().toLowerCase() || String(DEFAULT_HEARTBEAT_MINUTES);
  if (every === "off" || every === "0") return null;
  const when = parseWhen(`every ${/^\d+$/.test(every) ? `${every}m` : every}`);
  if (!when) throw new WorkspaceConfigError(`WORKSPACE_HEARTBEAT_EVERY must be minutes (5-1440, e.g. 120 or 2h) or "off", got "${every}"`);
  const activeRaw = env.WORKSPACE_HEARTBEAT_ACTIVE?.trim() || DEFAULT_HEARTBEAT_ACTIVE;
  if (activeRaw.toLowerCase() === "always") return { when };
  const active = parseActiveHours(activeRaw);
  if (!active) throw new WorkspaceConfigError(`WORKSPACE_HEARTBEAT_ACTIVE must be HH:MM-HH:MM or "always", got "${activeRaw}"`);
  return { when, active };
}

/** Cheap and fast on OpenRouter; already the screening image judge. */
export const DEFAULT_JUDGE_MODEL = "google/gemini-3.5-flash-lite";

/** The smallest current model in Pi's openai catalog; its "off" thinking maps to effort "none", so a verdict needs no reasoning budget. */
export const DEFAULT_JUDGE_CHATGPT_MODEL = "gpt-6-luna";

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
  const heartbeat = loadHeartbeat(env);
  const capRaw = env.WORKSPACE_PROACTIVE_DAILY_CAP?.trim() || String(DEFAULT_PROACTIVE_DAILY_CAP);
  if (!/^\d+$/.test(capRaw)) throw new WorkspaceConfigError(`WORKSPACE_PROACTIVE_DAILY_CAP must be a whole number, got "${capRaw}"`);
  const autoMode = env.WORKSPACE_AUTO_MODE?.trim().toLowerCase() || "on";
  if (autoMode !== "on" && autoMode !== "off") throw new WorkspaceConfigError(`WORKSPACE_AUTO_MODE must be "on" or "off", got "${autoMode}"`);
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
    heartbeat,
    proactiveDailyCap: Number(capRaw),
    autoMode: autoMode === "on",
    judgeModel: env.WORKSPACE_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL,
    judgeChatgptModel: env.WORKSPACE_JUDGE_CHATGPT_MODEL?.trim() || DEFAULT_JUDGE_CHATGPT_MODEL,
  };
}
