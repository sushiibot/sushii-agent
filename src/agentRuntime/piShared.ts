import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../logger.ts";
import { buildAgentEnv, type AgentEnvOptions } from "./agentEnv.ts";

const log = getLogger("agentRuntime.pi");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODEL_METADATA_TIMEOUT_MS = 5000;

/**
 * Resolve the model's real context window from OpenRouter's catalog so max_tokens is capped under
 * the true ceiling. Ported verbatim from wiki-sync's piSession — setting max_tokens to the full
 * context window (what OpenRouter reports as max_completion_tokens) makes every prompt overflow and
 * get silently rejected. Falls back to a safe buffer on any fetch/parse failure. Image input is declared
 * only when the catalog lists it, so an unknown model stays text-only.
 */
export async function resolveModelInfo(modelId: string, fallback: number): Promise<{ contextWindow: number; image: boolean }> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OpenRouter models catalog returned ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id: string; context_length?: number; architecture?: { input_modalities?: string[] } }> };
    const entry = payload.data?.find((m) => m.id === modelId);
    if (!entry?.context_length || entry.context_length <= 0) throw new Error(`model ${modelId} missing context_length`);
    const image = entry.architecture?.input_modalities?.includes("image") === true;
    log.info({ modelId, contextWindow: entry.context_length, image }, "resolved model metadata from OpenRouter");
    return { contextWindow: entry.context_length, image };
  } catch (err) {
    log.warn({ modelId, err, fallback }, "failed to resolve context window from OpenRouter catalog; using fallback");
    return { contextWindow: fallback, image: false };
  }
}

// Prefer the human-meaningful field of a tool's args for the activity line (the command, the path,
// the pattern), else compact JSON. Truncation happens downstream in activityLine.
export function summarizeToolArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of ["command", "path", "file_path", "pattern", "query", "url"]) {
      if (typeof a[k] === "string" && a[k]) return a[k] as string;
    }
    // Fallback: a compact key=value of scalar fields, never a raw JSON object dump.
    const parts = Object.entries(a)
      .filter(([, v]) => v != null && typeof v !== "object")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
    return parts.join(" ");
  }
  return "";
}

export interface OpenRouterModelOptions {
  agentDir: string;
  providerId: string;
  providerName: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokens?: number;
  fallbackContextWindow?: number;
  /** More OpenRouter model ids to register on the same provider (e.g. a `!model` list). */
  extraModels?: string[];
}

/** A ModelRuntime with one OpenRouter model registered inline, plus the limits it was sized with. */
export async function createOpenRouterModel(options: OpenRouterModelOptions) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  // ModelRuntime.create needs these files; empty is enough since the provider is registered inline.
  mkdirSync(options.agentDir, { recursive: true });
  const authPath = join(options.agentDir, "auth.json");
  const modelsPath = join(options.agentDir, "models.json");
  if (!existsSync(authPath)) writeFileSync(authPath, "{}");
  if (!existsSync(modelsPath)) writeFileSync(modelsPath, "{}");
  const modelRuntime: ModelRuntime = await ModelRuntime.create({ authPath, modelsPath });
  const ids = [options.model, ...(options.extraModels ?? []).filter((id) => id !== options.model)];
  const infos = await Promise.all(ids.map((id) => resolveModelInfo(id, options.fallbackContextWindow ?? 800_000)));
  const limits = ids.map((id, i) => ({
    id,
    contextWindow: infos[i]!.contextWindow,
    maxTokens: Math.min(options.maxOutputTokens ?? 65_536, infos[i]!.contextWindow),
    input: infos[i]!.image ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
  }));
  modelRuntime.registerProvider(options.providerId, {
    name: options.providerName,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    api: "openai-completions",
    models: limits.map(({ id, contextWindow, maxTokens, input }) => ({
      id,
      name: id,
      reasoning: false,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      samplingParams: { provider: { data_collection: "deny" } },
      compat: { sendSessionAffinityHeaders: true },
    })),
  });
  const models = new Map(ids.map((id) => [id, modelRuntime.getModel(options.providerId, id)] as const));
  const model = models.get(options.model);
  if (!model || [...models.values()].some((m) => !m)) throw new Error(`pi models ${options.providerId}/${ids.join(",")} failed to register`);
  const { contextWindow, maxTokens } = limits[0]!;
  return { modelRuntime, model, contextWindow, maxTokens, models: models as Map<string, NonNullable<typeof model>> };
}

export interface AgentBashToolOptions extends AgentEnvOptions {
  exposeSessionEnvironment?: boolean;
  /** Async per-call env (e.g. a repo-scoped git token), resolved before the command spawns. */
  prepareEnv?: (command: string, cwd: string) => Promise<Record<string, string>>;
}

/** Pi's bash tool under the allowlisted agent env; `extraEnv` is read per spawn (e.g. a fresh git token). */
export async function createAgentBashTool(
  cwd: string,
  extraEnv: () => Record<string, string> = () => ({}),
  options: AgentBashToolOptions = {},
): Promise<ToolDefinition> {
  const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
  // Pi's spawn hook is synchronous; `prepared` carries prepareEnv's result into it for exactly one call.
  let prepared: Record<string, string> = {};
  const tool = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: options.exposeSessionEnvironment,
    spawnHook: (context) => ({ ...context, env: buildAgentEnv(context.env, { ...extraEnv(), ...prepared }, options) }),
  });
  const prepare = options.prepareEnv;
  if (prepare) {
    const execute = tool.execute.bind(tool);
    tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      const env = await prepare(params.command, ctx?.cwd || cwd).catch(() => ({}));
      // Pi resolves the spawn context before its first await, so no other call can see this env.
      prepared = env;
      try {
        return execute(toolCallId, params, signal, onUpdate, ctx);
      } finally {
        prepared = {};
      }
    };
  }
  // Cast: the bash factory returns a specialized ToolDefinition; customTools wants the generic one.
  return tool as unknown as ToolDefinition;
}

type ToolSetSession = { getAllTools(): ReadonlyArray<{ name: string }>; getActiveToolNames(): string[]; dispose(): void };

/**
 * Throws (disposing the session) unless the session registered exactly `expected` and activated exactly
 * `expectedActive` (default: all of `expected`). Pi 0.99 ships codemode, tool_search and MCP as built-in
 * extensions; this keeps any of them, or a tool from a future default, from reaching the model unnoticed.
 */
export function assertExactTools(session: ToolSetSession, expected: readonly string[], label: string, expectedActive: readonly string[] = expected): void {
  const want = [...expected].sort();
  const wantActive = [...expectedActive].sort();
  const registered = session.getAllTools().map((t) => t.name).sort();
  const active = [...session.getActiveToolNames()].sort();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i]);
  if (same(registered, want) && same(active, wantActive)) return;
  session.dispose();
  throw new Error(`${label}: unexpected pi tool set (registered ${registered.join(",")}; active ${active.join(",")}; want ${want.join(",")}; want active ${wantActive.join(",")})`);
}
