import { goto } from '$app/navigation';
import { features, type AppFeature } from '$lib/core/features.svelte';

/**
 * Sends the screen to the chat once its feature is known to be off; call during component init. The
 * returned check is false meanwhile, so the layout renders nothing and no screen loads its data.
 */
export function featureGate(feature: AppFeature): () => boolean {
	$effect(() => {
		if (features.off(feature)) void goto('/chat', { replaceState: true });
	});
	return () => features.has(feature);
}
