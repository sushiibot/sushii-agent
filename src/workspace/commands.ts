import {
  MODELS_MAX,
  MODELS_SEARCH_MAX,
  RPC_METHODS,
  UNKNOWN_MODEL_CODE,
  chatCommandParams,
  modelsGetParams,
  modelsSearchParams,
  modelsSetParams,
  type ChatCommandParams,
  type ChatCommandResult,
  type ModelsResult,
  type ModelsSearchResult,
  type ModelCosts,
} from "../orchestration/contracts.ts";
import { openRouterCatalog, type CatalogModel } from "../agentRuntime/piShared.ts";
import { RpcHandlerError } from "../orchestration/transport/client.ts";
import { isChatModelId, type ModelChoice } from "./modelChoice.ts";

export interface CommandDeps {
  principalId: string;
  /** `!compact`: flush, compact, reload; tokens before/after or why it didn't. */
  compact(): Promise<{ tokensBefore: number; tokensAfter: number | null } | { error: string }>;
  choice: ModelChoice;
  /** The main session's model right now, as the footer names it. */
  currentModel?(): string | null;
  /** `!tasks [project]`, read straight from the files. */
  tasks(arg?: string): string;
  /** When ChatGPT's cool-down ends, while the fallback answers; null otherwise. */
  fallbackUntil?(): number | null;
  /** OpenRouter's catalog; the shared cached one by default. */
  catalog?(): Promise<CatalogModel[]>;
  /** Recorded usage for the current conversation session and the workspace's local day. */
  costs?(conversationId?: string): Promise<ModelCosts>;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Owner commands the workspace answers without the model; the bot's router sends them as chat/command. */
export async function runCommand(params: ChatCommandParams, deps: CommandDeps): Promise<ChatCommandResult> {
  switch (params.command) {
    case "compact": {
      const res = await deps.compact();
      if ("error" in res) return { text: `Didn't compact: ${res.error}` };
      return { text: `🗜️ Compacted: ${fmt(res.tokensBefore)} → ${res.tokensAfter === null ? "?" : `~${fmt(res.tokensAfter)}`} tokens.` };
    }
    case "model": {
      if (!params.args) return { text: deps.choice.describe(deps.currentModel?.() ?? null) };
      const unknown = await notOnOpenRouter(deps, params.args);
      if (unknown) return { text: unknown };
      const res = await deps.choice.select(params.args);
      if (!res.ok) return { text: res.error };
      const e = res.entry;
      const where = e.backend === "chatgpt" ? `ChatGPT \`${e.id}\` (OpenRouter while ChatGPT is unavailable)` : `OpenRouter \`${e.id}\``;
      return { text: res.changed ? `Model set to **${e.alias}**: ${where}, from the next turn.` : `Already on **${e.alias}** (${where}).` };
    }
    case "tasks":
      return { text: deps.tasks(params.args) };
  }
}

function facts(m: CatalogModel | undefined) {
  return m ? { contextWindow: m.contextWindow, priceIn: m.priceIn, priceOut: m.priceOut, image: m.image } : {};
}

/** The choice, the list with catalog facts (ChatGPT entries as OpenAI's listing), and the fallback. */
async function models(deps: CommandDeps): Promise<ModelsResult> {
  const { choice } = deps;
  const catalog = await (deps.catalog ?? openRouterCatalog)().catch(() => [] as CatalogModel[]);
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const cur = choice.current();
  const entries = choice.list.slice(0, MODELS_MAX);
  if (cur && !entries.includes(cur) && !choice.list.includes(cur)) entries.push(cur);
  const until = deps.fallbackUntil?.() ?? null;
  return {
    current: cur?.alias ?? null,
    models: entries.map((e) => ({
      alias: e.alias,
      backend: e.backend,
      id: e.id,
      // A ChatGPT plan model isn't billed per token, so only its window is worth showing.
      ...(e.backend === "chatgpt" ? { contextWindow: byId.get(`openai/${e.id}`)?.contextWindow } : facts(byId.get(e.id))),
    })),
    fallback: choice.currentFallback(),
    fallbackUntil: until === null ? null : new Date(until).toISOString(),
  };
}

/** Why an OpenRouter id can't be picked: it isn't in a readable catalog, or can't take tools. Null when it
 *  can, when it is a list alias or ChatGPT entry, or when the catalog is down (the id is then trusted). */
async function notOnOpenRouter(deps: CommandDeps, target: string, fallback = false): Promise<string | null> {
  const entry = fallback ? null : deps.choice.resolve(target);
  if (entry && (entry.backend === "chatgpt" || deps.choice.list.includes(entry))) return null;
  const id = target.trim();
  if (!isChatModelId(id)) return null;
  const catalog = await (deps.catalog ?? openRouterCatalog)().catch(() => null);
  if (!catalog) return null;
  const found = catalog.find((m) => m.id === id);
  if (!found) return `"${id}" isn't on OpenRouter; search for it in the app, or check the id`;
  if (!found.tools) return `"${id}" can't call tools, which the agent needs`;
  if (found.contextWindow < MIN_CONTEXT_WINDOW) return `"${id}" has a ${found.contextWindow.toLocaleString("en-US")}-token context, too small for the agent`;
  return null;
}

/** Below this the system prompt, tools and a few turns don't fit. */
export const MIN_CONTEXT_WINDOW = 100_000;

/** Tool-capable catalog models whose id or name has every word of `query`, cheapest first. */
async function search(deps: CommandDeps, query: string): Promise<ModelsSearchResult> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const catalog = await (deps.catalog ?? openRouterCatalog)();
  const hits = catalog
    .filter((m) => m.tools && isChatModelId(m.id) && m.contextWindow >= MIN_CONTEXT_WINDOW && words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)))
    .sort((a, b) => (a.priceIn ?? Infinity) + (a.priceOut ?? Infinity) - ((b.priceIn ?? Infinity) + (b.priceOut ?? Infinity)));
  return { models: hits.slice(0, MODELS_SEARCH_MAX).map((m) => ({ id: m.id, name: m.name, ...facts(m) })) };
}

export function commandHandlers(deps: CommandDeps): Record<string, (params: unknown) => Promise<unknown>> {
  const checkPrincipal = (principalId: string) => {
    if (principalId !== deps.principalId) throw new Error(`principal mismatch: this workspace serves ${deps.principalId}, got ${principalId}`);
  };
  return {
    [RPC_METHODS.modelsGet]: async (p) => {
      const params = modelsGetParams.parse(p);
      checkPrincipal(params.principalId);
      const [result, cost] = await Promise.all([models(deps), deps.costs?.(params.conversationId)]);
      return { ...result, ...(cost ? { cost } : {}) };
    },
    // Same as `!model <alias>`: it applies from the next turn, once a live session has registered the model.
    [RPC_METHODS.modelsSet]: async (p) => {
      const params = modelsSetParams.parse(p);
      checkPrincipal(params.principalId);
      const unknown = await notOnOpenRouter(deps, params.alias, params.role === "fallback");
      if (unknown) throw new RpcHandlerError(unknown, UNKNOWN_MODEL_CODE);
      const res = params.role === "fallback" ? await deps.choice.selectFallback(params.alias) : await deps.choice.select(params.alias);
      if (!res.ok) throw new RpcHandlerError(res.error, UNKNOWN_MODEL_CODE);
      return models(deps);
    },
    [RPC_METHODS.modelsSearch]: async (p) => {
      const params = modelsSearchParams.parse(p);
      checkPrincipal(params.principalId);
      return search(deps, params.query);
    },
    [RPC_METHODS.chatCommand]: async (p) => {
      const params = chatCommandParams.parse(p);
      if (params.principalId !== deps.principalId) throw new Error(`principal mismatch: this workspace serves ${deps.principalId}, got ${params.principalId}`);
      return runCommand(params, deps);
    },
  };
}
