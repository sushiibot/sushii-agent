import type { ChatUsage } from '$lib/core/realtime/events';

/** `openrouter/deepseek/deepseek-v4.1-flash` reads as `deepseek-v4.1-flash`. */
export function shortModel(model: string): string {
	return model.split('/').filter(Boolean).at(-1) ?? model;
}

export function formatCost(usd: number): string {
	if (usd === 0) return '$0';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

export const formatTokens = (n: number) => n.toLocaleString('en-US');

/** One muted line: model, context used, cost when the provider priced it. */
export function usageLine(usage: ChatUsage): string {
	const parts = [shortModel(usage.model)];
	if (usage.contextPct !== undefined) parts.push(`ctx ${Math.round(usage.contextPct)}%`);
	if (usage.costUsd !== undefined) parts.push(formatCost(usage.costUsd));
	return parts.join(' · ');
}
