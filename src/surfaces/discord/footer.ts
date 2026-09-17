import type { ToolActivity, TurnUsage } from "../../core/contracts.ts";

export function formatToolArg(value: unknown): string {
  if (typeof value === "string") {
    const truncated = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `"${truncated}"`;
  }
  return JSON.stringify(value);
}

/** Returns [inputPricePerM, outputPricePerM] in USD for known model name patterns. */
function modelPricing(model: string): [number, number] | null {
  const m = model.toLowerCase();
  if (m.includes("opus")) return [15, 75];
  if (m.includes("sonnet")) return [3, 15];
  if (m.includes("haiku")) return [0.8, 4];
  return null;
}

export function renderFooter(usage: TurnUsage, tools: ToolActivity[]): string {
  const ctxPct = Math.round((usage.contextTokens / usage.contextLimit) * 100);
  const pricing = modelPricing(usage.model);
  const costStr = pricing
    ? ` · $${((usage.inputTokens / 1_000_000) * pricing[0] + (usage.outputTokens / 1_000_000) * pricing[1]).toFixed(4)}`
    : "";
  const cacheStr =
    usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0
      ? ` · cache ${usage.cacheReadTokens.toLocaleString()}r ${usage.cacheWriteTokens.toLocaleString()}w`
      : "";
  const statsLine = `-# ${usage.model} · ${usage.contextTokens.toLocaleString()} ctx (${ctxPct}%) · ${usage.outputTokens.toLocaleString()} out${cacheStr}${costStr}`;
  if (tools.length === 0) return statsLine;

  const toolLines = tools.map(({ name, input }) => {
    const args = Object.entries(input)
      .map(([k, v]) => `${k}=${formatToolArg(v)}`)
      .join(", ");
    return `-# - ${args ? `${name}(${args})` : name}`;
  });
  return `${statsLine}\n${toolLines.join("\n")}`;
}
