import type { HistoryCost } from '$lib/core/realtime/events';

/** A recorded usage total, not a bill: subscriptions and missing provider prices stay explicit. */
export function costLabel(cost: HistoryCost | undefined): string {
	if (!cost || !cost.recordedRuns) return 'Cost unavailable';
	const amount =
		cost.usd > 0 && cost.usd < 0.0001
			? '<$0.0001'
			: `$${cost.usd.toFixed(cost.usd > 0 && cost.usd < 0.01 ? 4 : 2)}`;
	return `${amount} cost${cost.unpricedRuns ? ' · partial' : ''}`;
}

export function costDescription(cost: HistoryCost | undefined): string {
	if (!cost) return 'Recorded model costs are unavailable for this day.';
	return `Recorded USD model usage for ${cost.recordedRuns} runs. ${cost.unpricedRuns} runs have no recorded price, including subscription models. Each run is counted once, including delegated agents. Costs belong to the day a run started; they are not billing totals.`;
}
