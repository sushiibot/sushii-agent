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
  /** Context thresholds of the main session; defaults when absent. */
  economy?: EconomyConfig;
  /** The fixed `!model` list; DEFAULT_MODELS when absent. */
  models?: ModelEntry[];
  /** TASKS.md staleness and cap rules; DEFAULT_TASK_RULES when absent. */
  tasks?: TaskRules;
}

export interface EconomyConfig {
  /** Past this many context tokens, old tool output is cleared. */
  hygieneTokens: number;
  /** Pi auto-compacts past this many tokens (at most COMPACT_MAX_FILL of the window). */
  compactTokens: number;
  /** Tokens kept verbatim after a compaction. */
  keepRecentTokens: number;
  /** Idle minutes before a big session rotates; OPENROUTER_IDLE_ROTATE_MIN caps it on OpenRouter. */
  idleRotateMin: number;
  /** A session rotates at idle only past this many tokens. */
  idleRotateTokens: number;
}

export const DEFAULT_ECONOMY: EconomyConfig = {
  hygieneTokens: 150_000,
  compactTokens: 200_000,
  keepRecentTokens: 8_000,
  idleRotateMin: 25,
  idleRotateTokens: 100_000,
};

/** OpenRouter's sticky provider routing lapses after 10 idle minutes; rotate before it does. */
export const OPENROUTER_IDLE_ROTATE_MIN = 8;

export type ModelBackend = "chatgpt" | "openrouter";

export interface ModelEntry {
  alias: string;
  backend: ModelBackend;
  /** Model id on Pi's `openai` provider (chatgpt) or on OpenRouter. */
  id: string;
}

/** The ChatGPT plan models, then cheap tool-capable OpenRouter ones (picked on price and context, 2026-10). */
export const DEFAULT_MODELS_SPEC = [
  "sol=chatgpt:gpt-6.1-sol",
  "luna=chatgpt:gpt-6-luna",
  "deepseek-pro=openrouter:deepseek/deepseek-v4-pro",
  "deepseek-flash=openrouter:deepseek/deepseek-v4-flash",
  "qwen-plus=openrouter:qwen/qwen3.7-plus",
  "mimo-pro=openrouter:xiaomi/mimo-v2.6-pro",
  "glm-flash=openrouter:z-ai/glm-5.3-flash",
  "luna-api=openrouter:openai/gpt-6-luna",
].join(",");

export interface TaskRules {
  staleDaysQuick: number;
  autodropDaysQuick: number;
  staleDaysProject: number;
  autodropDaysProject: number;
  /** Open quick items plus projects in the index. */
  maxOpen: number;
}

export const DEFAULT_TASK_RULES: TaskRules = { staleDaysQuick: 2, autodropDaysQuick: 5, staleDaysProject: 7, autodropDaysProject: 21, maxOpen: 15 };

export function economyOf(config: Pick<WorkspaceConfig, "economy">): EconomyConfig {
  return config.economy ?? DEFAULT_ECONOMY;
}

export function taskRulesOf(config: Pick<WorkspaceConfig, "tasks">): TaskRules {
  return config.tasks ?? DEFAULT_TASK_RULES;
}

/** `alias=backend:id,…`; throws WorkspaceConfigError on a malformed or duplicate entry. */
export function parseModelList(spec: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z0-9][a-z0-9._-]*)=(chatgpt|openrouter):(\S+)$/i.exec(part);
    if (!m) throw new WorkspaceConfigError(`WORKSPACE_MODELS entry must be alias=chatgpt:<id> or alias=openrouter:<id>, got "${part}"`);
    const alias = m[1]!.toLowerCase();
    if (entries.some((e) => e.alias === alias)) throw new WorkspaceConfigError(`WORKSPACE_MODELS lists "${alias}" twice`);
    entries.push({ alias, backend: m[2]!.toLowerCase() as ModelBackend, id: m[3]! });
  }
  if (!entries.length) throw new WorkspaceConfigError("WORKSPACE_MODELS is empty");
  return entries;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new WorkspaceConfigError(`${name} must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

function loadEconomy(env: NodeJS.ProcessEnv): EconomyConfig {
  return {
    hygieneTokens: positiveInt(env, "WORKSPACE_HYGIENE_TOKENS", DEFAULT_ECONOMY.hygieneTokens),
    compactTokens: positiveInt(env, "WORKSPACE_COMPACT_TOKENS", DEFAULT_ECONOMY.compactTokens),
    keepRecentTokens: positiveInt(env, "WORKSPACE_KEEP_RECENT_TOKENS", DEFAULT_ECONOMY.keepRecentTokens),
    idleRotateMin: positiveInt(env, "WORKSPACE_IDLE_ROTATE_MIN", DEFAULT_ECONOMY.idleRotateMin),
    idleRotateTokens: positiveInt(env, "WORKSPACE_IDLE_ROTATE_TOKENS", DEFAULT_ECONOMY.idleRotateTokens),
  };
}

function loadTaskRules(env: NodeJS.ProcessEnv): TaskRules {
  const d = DEFAULT_TASK_RULES;
  return {
    staleDaysQuick: positiveInt(env, "WORKSPACE_TASK_STALE_DAYS_QUICK", d.staleDaysQuick),
    autodropDaysQuick: positiveInt(env, "WORKSPACE_TASK_AUTODROP_DAYS_QUICK", d.autodropDaysQuick),
    staleDaysProject: positiveInt(env, "WORKSPACE_TASK_STALE_DAYS", d.staleDaysProject),
    autodropDaysProject: positiveInt(env, "WORKSPACE_TASK_AUTODROP_DAYS", d.autodropDaysProject),
    maxOpen: positiveInt(env, "WORKSPACE_TASK_MAX_OPEN", d.maxOpen),
  };
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
    economy: loadEconomy(env),
    models: parseModelList(env.WORKSPACE_MODELS?.trim() || DEFAULT_MODELS_SPEC),
    tasks: loadTaskRules(env),
  };
}
