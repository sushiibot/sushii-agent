import { getLogger } from "../../logger.ts";

const log = getLogger("workspace.subagents");
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 10_000;

/** USD per million tokens. `input` is uncached input: Pi reports cache reads and writes separately. */
export interface TokenPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export function totalTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheRead + t.cacheWrite;
}

export function costUsd(t: TokenCounts, p: TokenPrice): number {
  return (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000;
}

function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
}

/** The model's OpenRouter list price, or null when the catalog is unreachable or lacks it. */
export async function fetchOpenRouterPrice(modelId: string): Promise<TokenPrice | null> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OpenRouter models catalog returned ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id: string; pricing?: Record<string, unknown> }> };
    const p = payload.data?.find((m) => m.id === modelId)?.pricing;
    const input = perMillion(p?.prompt);
    const output = perMillion(p?.completion);
    if (input === undefined || output === undefined) throw new Error(`model ${modelId} has no prompt/completion price`);
    return { input, output, cacheRead: perMillion(p?.input_cache_read) ?? input, cacheWrite: perMillion(p?.input_cache_write) ?? input };
  } catch (err) {
    log.warn({ err, modelId }, "no OpenRouter price for the subagent model; the cost cap uses the fallback price");
    return null;
  }
}
