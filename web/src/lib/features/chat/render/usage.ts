import type { ChatUsage, HistoryCost } from '$lib/core/realtime/events';

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

/** A known empty aggregate is zero; unpriced runs never become a free total. */
export function aggregateCost(cost: HistoryCost | undefined, truncated = false): string {
	if (!cost || (!cost.recordedRuns && (cost.unpricedRuns || truncated))) return 'Unavailable';
	const amount = cost.usd > 0 && cost.usd < 0.0001 ? '<$0.0001' : formatCost(cost.usd);
	return `${amount}${cost.unpricedRuns || truncated ? ' · partial' : ''}`;
}

export const formatTokens = (n: number) => n.toLocaleString('en-US');

/** One muted line: model, context used, cost when the provider priced it. */
export function usageLine(usage: ChatUsage): string {
	const parts = [shortModel(usage.model)];
	if (usage.contextPct !== undefined) parts.push(`ctx ${Math.round(usage.contextPct)}%`);
	if (usage.costUsd !== undefined) parts.push(formatCost(usage.costUsd));
	return parts.join(' · ');
}

/** The last reply's usage as label/value rows, model first. */
export function usageRows(u: ChatUsage): [string, string][] {
	const rows: [string, string][] = [['Model', u.model]];
	if (u.contextPct !== undefined) rows.push(['Context used', `${Math.round(u.contextPct)}%`]);
	rows.push(
		['Tokens in', formatTokens(u.inputTokens)],
		['Tokens out', formatTokens(u.outputTokens)]
	);
	if (u.cacheRead !== undefined) rows.push(['Cache read', formatTokens(u.cacheRead)]);
	if (u.cacheWrite !== undefined) rows.push(['Cache write', formatTokens(u.cacheWrite)]);
	if (u.costUsd !== undefined) rows.push(['Cost', formatCost(u.costUsd)]);
	return rows;
}

/** How full the context is: amber from 80%, red from 95%, near where the agent compacts. */
export function contextTone(pct: number | null): 'normal' | 'waiting' | 'failed' {
	if (pct === null || pct < 80) return 'normal';
	return pct < 95 ? 'waiting' : 'failed';
}

/** `~deepseek/deepseek-v4-pro` reads as `deepseek-v4-pro`. */
export function modelName(id: string): string {
	return shortModel(id).replace(/^~/, '');
}
