import { goto } from '$app/navigation';
import { features } from '$lib/core/features.svelte';
import type { WebFeature } from '$lib/core/realtime/events';

/** Sends the screen Home once the bot says its feature is off; call during component init. */
export function featureGate(feature: WebFeature) {
	$effect(() => {
		if (features.off(feature)) void goto('/', { replaceState: true });
	});
}
