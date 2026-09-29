import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../../logger.ts";
import { buildAgentEnv, type AgentEnvOptions } from "./agentEnv.ts";

const log = getLogger("orchestration.runner.pi");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODEL_METADATA_TIMEOUT_MS = 5000;

/**
 * Resolve the model's real context window from OpenRouter's catalog so max_tokens is capped under
 * the true ceiling. Ported verbatim from wiki-sync's piSession — setting max_tokens to the full
 * context window (what OpenRouter reports as max_completion_tokens) makes every prompt overflow and
 * get silently rejected. Falls back to a safe buffer on any fetch/parse failure.
 */
export async function resolveContextWindow(modelId: string, fallback: number): Promise<number> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OpenRouter models catalog returned ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
    const entry = payload.data?.find((m) => m.id === modelId);
    if (!entry?.context_length || entry.context_length <= 0) throw new Error(`model ${modelId} missing context_length`);
    return entry.context_length;
  } catch (err) {
    log.warn({ modelId, err, fallback }, "failed to resolve context window from OpenRouter catalog; using fallback");
    return fallback;
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
  const contextWindow = await resolveContextWindow(options.model, options.fallbackContextWindow ?? 800_000);
  const maxTokens = Math.min(options.maxOutputTokens ?? 65_536, contextWindow);
  modelRuntime.registerProvider(options.providerId, {
    name: options.providerName,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    api: "openai-completions",
    models: [
      {
        id: options.model,
        name: options.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
        samplingParams: { provider: { data_collection: "deny" } },
        compat: { sendSessionAffinityHeaders: true },
      },
    ],
  });
  const model = modelRuntime.getModel(options.providerId, options.model);
  if (!model) throw new Error(`pi model ${options.providerId}/${options.model} failed to register`);
  return { modelRuntime, model, contextWindow, maxTokens };
}

/** Pi's bash tool under the allowlisted agent env; `extraEnv` is read per spawn (e.g. a fresh git token). */
export async function createAgentBashTool(
  cwd: string,
  extraEnv: () => Record<string, string> = () => ({}),
  options: AgentEnvOptions & { exposeSessionEnvironment?: boolean } = {},
): Promise<ToolDefinition> {
  const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
  const tool = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: options.exposeSessionEnvironment,
    spawnHook: (context) => ({ ...context, env: buildAgentEnv(context.env, extraEnv(), options) }),
  });
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
