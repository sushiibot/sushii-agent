import { goto } from '$app/navigation';
import { features, type AppFeature } from '$lib/core/features.svelte';

/** Sends the screen Home once its feature is known to be off; call during component init. */
export function featureGate(feature: AppFeature) {
	$effect(() => {
		if (features.off(feature)) void goto('/', { replaceState: true });
	});
}
