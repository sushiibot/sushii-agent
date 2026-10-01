import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../logger.ts";
import { buildAgentEnv, type AgentEnvOptions } from "./agentEnv.ts";

const log = getLogger("agentRuntime.pi");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODEL_METADATA_TIMEOUT_MS = 5000;

/** One model in OpenRouter's catalog, as far as the agent needs it. */
export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  image: boolean;
  /** It takes tool definitions; the agent can't work without them. */
  tools: boolean;
  /** USD per million tokens; null when the catalog leaves it out. */
  priceIn: number | null;
  priceOut: number | null;
}

type RawCatalogEntry = {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
};

const CATALOG_TTL_MS = 10 * 60_000;
/** An unreadable catalog is remembered this long, so an outage doesn't cost every caller a timeout. */
const CATALOG_FAILURE_TTL_MS = 60_000;
let catalogCache: { at: number; models: CatalogModel[] } | null = null;
let catalogFailure: { at: number; error: Error } | null = null;
let catalogInFlight: Promise<CatalogModel[]> | null = null;

const perMillion = (raw: string | undefined) => {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : null;
};

/** OpenRouter's model catalog, cached for ten minutes; throws when it can't be read. */
export async function openRouterCatalog(now = Date.now()): Promise<CatalogModel[]> {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  if (catalogFailure && now - catalogFailure.at < CATALOG_FAILURE_TTL_MS) throw catalogFailure.error;
  catalogInFlight ??= fetchCatalog(now)
    .catch((err: unknown) => {
      catalogFailure = { at: now, error: err instanceof Error ? err : new Error(String(err)) };
      throw catalogFailure.error;
    })
    .finally(() => {
      catalogInFlight = null;
    });
  return catalogInFlight;
}

async function fetchCatalog(now: number): Promise<CatalogModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenRouter models catalog returned ${res.status}`);
  const payload = (await res.json()) as { data?: RawCatalogEntry[] };
  const models = (payload.data ?? [])
    .filter((m) => typeof m.id === "string" && (m.context_length ?? 0) > 0)
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.context_length!,
      image: m.architecture?.input_modalities?.includes("image") === true,
      tools: m.supported_parameters?.includes("tools") === true,
      priceIn: perMillion(m.pricing?.prompt),
      priceOut: perMillion(m.pricing?.completion),
    }));
  catalogCache = { at: now, models };
  catalogFailure = null;
  return models;
}

/** Test seam: forget the cached catalog and any remembered failure. */
export function clearOpenRouterCatalog(): void {
  catalogCache = null;
  catalogFailure = null;
  catalogInFlight = null;
}

/**
 * Resolve the model's real context window from OpenRouter's catalog so max_tokens is capped under
 * the true ceiling: setting max_tokens to the full context window (what OpenRouter reports as
 * max_completion_tokens) makes every prompt overflow and get silently rejected. Falls back to a safe
 * buffer on any fetch/parse failure. Image input is declared only when the catalog lists it, so an
 * unknown model stays text-only.
 */
export async function resolveModelInfo(modelId: string, fallback: number): Promise<{ contextWindow: number; image: boolean; resolved: boolean }> {
  try {
    const entry = (await openRouterCatalog()).find((m) => m.id === modelId);
    if (!entry) throw new Error(`model ${modelId} missing from the catalog`);
    log.info({ modelId, contextWindow: entry.contextWindow, image: entry.image }, "resolved model metadata from OpenRouter");
    return { contextWindow: entry.contextWindow, image: entry.image, resolved: true };
  } catch (err) {
    log.warn({ modelId, err, fallback }, "failed to resolve context window from OpenRouter catalog; using fallback");
    return { contextWindow: fallback, image: false, resolved: false };
  }
}

/** A reply may use at most this share of the window: a cap as large as the window overflows on any prompt. */
const MAX_OUTPUT_SHARE = 0.25;

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
  type Limit = { id: string; contextWindow: number; maxTokens: number; input: ("text" | "image")[]; guessed: boolean };
  const limits = new Map<string, Limit>();
  const resolve = async (ids: string[]) => {
    // A guessed window is resolved again, so a catalog outage at pick time doesn't stick for the session.
    const fresh = ids.filter((id) => !limits.has(id) || limits.get(id)!.guessed);
    const infos = await Promise.all(fresh.map((id) => resolveModelInfo(id, options.fallbackContextWindow ?? 800_000)));
    fresh.forEach((id, i) =>
      limits.set(id, {
        id,
        contextWindow: infos[i]!.contextWindow,
        maxTokens: Math.min(options.maxOutputTokens ?? 65_536, Math.floor(infos[i]!.contextWindow * MAX_OUTPUT_SHARE)),
        input: infos[i]!.image ? ["text", "image"] : ["text"],
        guessed: !infos[i]!.resolved,
      }),
    );
  };
  const models = new Map<string, NonNullable<ReturnType<ModelRuntime["getModel"]>>>();
  // Re-registering the provider replaces its model list, so every call registers all ids seen so far.
  const registerAll = () => {
    modelRuntime.registerProvider(options.providerId, {
      name: options.providerName,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      api: "openai-completions",
      models: [...limits.values()].map(({ id, contextWindow, maxTokens, input }) => ({
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
    for (const id of limits.keys()) {
      const m = modelRuntime.getModel(options.providerId, id);
      if (!m) throw new Error(`pi model ${options.providerId}/${id} failed to register`);
      models.set(id, m);
    }
  };
  await resolve([options.model, ...(options.extraModels ?? [])]);
  registerAll();
  const model = models.get(options.model)!;
  const { contextWindow, maxTokens } = limits.get(options.model)!;
  /** Adds OpenRouter models to this runtime after it was made, e.g. one just picked in the app. */
  const register = async (ids: string[]) => {
    if (ids.every((id) => limits.has(id) && !limits.get(id)!.guessed)) return;
    await resolve(ids);
    registerAll();
  };
  return { modelRuntime, model, contextWindow, maxTokens, models, register };
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
